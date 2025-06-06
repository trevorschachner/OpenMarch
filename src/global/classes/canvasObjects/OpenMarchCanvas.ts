import { fabric } from "fabric";
import CanvasMarcher from "./CanvasMarcher";
import StaticCanvasMarcher from "./StaticCanvasMarcher";
import { Pathway } from "./Pathway";
import FieldProperties from "@/global/classes/FieldProperties";
import CanvasListeners from "../../../components/canvas/listeners/CanvasListeners";
import Marcher from "@/global/classes/Marcher";
import MarcherPage from "@/global/classes/MarcherPage";
import { ActiveObjectArgs } from "../../../components/canvas/CanvasConstants";
import * as CoordinateActions from "@/utilities/CoordinateActions";
import Page from "@/global/classes/Page";
import MarcherLine from "@/global/classes/canvasObjects/MarcherLine";
import * as Selectable from "./interfaces/Selectable";
import { ShapePage } from "electron/database/tables/ShapePageTable";
import { MarcherShape } from "./MarcherShape";
import { rgbaToString } from "../FieldTheme";
import { UiSettings } from "@/stores/UiSettingsStore";
import {
    SectionAppearance,
    getSectionAppearance,
} from "@/global/classes/SectionAppearance";

/**
 * A custom class to extend the fabric.js canvas for OpenMarch.
 */
export default class OpenMarchCanvas extends fabric.Canvas {
    /** The drag start time is used to determine if the mouse was clicked or dragged */
    readonly DRAG_TIMER_MILLISECONDS = 300;
    /** The distance threshold is used to determine if the mouse was clicked or dragged */
    readonly DISTANCE_THRESHOLD = 20;

    /** The FieldProperties this OpenMarchCanvas has been built on */
    private _fieldProperties: FieldProperties;

    private _backgroundImage: fabric.Image | null;
    private _bgImageValues?: {
        left: number;
        top: number;
        scale: number;
        imgAspectRatio: number;
    };

    /** The current page this canvas is on */
    currentPage: Page;
    /**
     * This lock prevents infinite loops when selecting marchers.
     * Set it to true when changing selection, and check that this is false before handling selection.
     * Set it to false after making selection
     */
    handleSelectLock = false;
    /** Denotes whether the Canvas itself is being dragged by the user to pan the view */
    isDragging = false;
    /** The point where the user's mouse was when they started dragging the canvas. This is used to adjust the viewport transform. */
    panDragStartPos: { x: number; y: number } = { x: 0, y: 0 };
    /** The time and the position of the user's mouse when selecting a fabric object */
    selectDragStart: { x: number; y: number; time: number } = {
        x: 0,
        y: 0,
        time: 0,
    };
    /** Variables for tracking pan position */
    lastPosX = 0;
    lastPosY = 0;
    marcherShapes: MarcherShape[] = [];
    /**
     * The reference to the grid (the lines on the field) object to use for caching
     * This is needed to disable object caching while zooming, which greatly improves responsiveness.
     */
    staticGridRef: fabric.Group = new fabric.Group([]);
    private _listeners?: CanvasListeners;

    // ---- AlignmentEvent changes ----
    /**
     * Updates the event marchers in global state. Must be set in a React component
     * Note - this must be called manually and isn't called in the eventMarchers setter (infinite loop)
     */
    setGlobalEventMarchers: (marchers: Marcher[]) => void = () => {
        console.error("setGlobalEventMarchers not set");
    };
    /**
     * Updates the new marcher pages in global state. Must be set in a React component
     */
    setGlobalNewMarcherPages: (marcherPages: MarcherPage[]) => void = () => {
        console.error("setGlobalNewMarcherPages not set");
    };
    /** The marchers associated with a given event on the canvas. E.g. making a line or a box */
    private _eventMarchers: CanvasMarcher[] = [];
    // ----------------------------

    /** The timeout for when object caching should be re-enabled */
    private _zoomTimeout: NodeJS.Timeout | undefined;
    /** The UI settings for the canvas */
    private _uiSettings: UiSettings;

    /** Track touch points for pinch-to-zoom */
    private touchPoints: { [key: number]: { x: number; y: number } } = {};
    private lastPinchDistance: number = 0;

    /** CSS transform values for the canvas container */
    private transformValues = {
        translateX: 0,
        translateY: 0,
        scale: 1,
        originX: 0,
        originY: 0,
    };

    /** Track state for CSS-based panning */
    private isPanning = false;

    /** Track pinch gesture for zooming */
    private initialPinchDistance = 0;

    /** Reference to the canvas CSS wrapper element */
    private cssZoomWrapper: HTMLDivElement | null = null;

    /** Add a user preference toggle for trackpad mode in UI */
    private trackpadModeEnabled = this.isMacOS(); // Default to true on Mac

    /** Flag to force trackpad pan mode when Alt key is pressed */
    private forceTrackpadPan = false;

    /**
     * Constants for zoom limits
     */
    private readonly MIN_ZOOM = 0.5; // 50% (zoomed in, field is twice as big as viewport)
    private readonly MAX_ZOOM = 2.0; // 200% (zoomed out, field is half as big as viewport)
    private readonly ZOOM_STEP = 0.05; // 5% increments for smoother zooming

    // Sensitivity settings
    private panSensitivity = 0.5; // Reduced for smoother panning
    private zoomSensitivity = 0.03; // Reduced for gentler zooming
    private trackpadPanSensitivity = 0.5; // Reduced to be less jumpy

    constructor({
        canvasRef,
        fieldProperties,
        uiSettings,
        currentPage,
        listeners,
    }: {
        canvasRef: HTMLCanvasElement | null;
        fieldProperties: FieldProperties;
        uiSettings: UiSettings;
        currentPage?: Page;
        listeners?: CanvasListeners;
    }) {
        super(canvasRef, {
            selectionColor: rgbaToString({
                ...fieldProperties.theme.shape,
                a: 0.2,
            }),
            selectionBorderColor: rgbaToString(fieldProperties.theme.shape),
            selectionLineWidth: 2,
            fireRightClick: true, // Allow right click events
            stopContextMenu: false, // Allow right click context menu for panning
            enableRetinaScaling: true, // Better display on retina screens
        });

        // CRITICAL: Completely disable Fabric's built-in mousewheel handler to avoid conflicts
        // @ts-ignore - Accessing private property to disable built-in handling
        this.off("mouse:wheel");

        // Init the DOM wrapper for the canvas if available
        if (canvasRef) {
            this.setupExternalPanZoomContainer(canvasRef);
        }

        if (currentPage) this.currentPage = currentPage;
        // If no page is provided, create a default page
        else
            this.currentPage = {
                id: 1,
                name: "Example",
                order: 1,
                counts: 4,
                nextPageId: null,
                previousPageId: null,
                measures: [],
                duration: 120,
                notes: null,
                isSubset: false,
                beats: [],
                measureBeatToStartOn: 1,
                measureBeatToEndOn: 0,
                timestamp: 0,
            };

        // Only set canvas size if canvasRef is available
        if (canvasRef) {
            this.refreshCanvasSize();
            // Update canvas size on window resize
            window.addEventListener("resize", (evt) => {
                this.refreshCanvasSize();
            });
        }

        this._fieldProperties = fieldProperties;

        this.fieldProperties = fieldProperties;

        // Set the UI settings
        this._uiSettings = uiSettings;

        // Initialize trackpad mode based on settings and platform
        this.trackpadModeEnabled = uiSettings.mouseSettings.trackpadMode;

        // Initialize sensitivity settings from UI settings
        if (uiSettings.mouseSettings.panSensitivity) {
            this.panSensitivity = uiSettings.mouseSettings.panSensitivity;
        }
        if (uiSettings.mouseSettings.trackpadPanSensitivity) {
            this.trackpadPanSensitivity =
                uiSettings.mouseSettings.trackpadPanSensitivity;
        }
        if (uiSettings.mouseSettings.zoomSensitivity) {
            this.zoomSensitivity = uiSettings.mouseSettings.zoomSensitivity;
        }

        if (listeners) this.setListeners(listeners);

        this._backgroundImage = null;
        this.refreshBackgroundImage();

        this.requestRenderAll();
    }

    /**
     * Set up an external container to handle pan and zoom, completely independent
     * of Fabric.js's internal handling, similar to how modern design tools work
     */
    private setupExternalPanZoomContainer(canvasRef: HTMLCanvasElement) {
        const canvasContainer = canvasRef.parentElement as HTMLDivElement;
        if (!canvasContainer) return;

        // Store reference to the container
        this.cssZoomWrapper = canvasContainer;

        // Create a wrapper element that will mask the canvas and handle overflow
        const outerWrapper = document.createElement("div");
        outerWrapper.className = "fabric-outer-container";
        outerWrapper.style.position = "absolute";
        outerWrapper.style.top = "0";
        outerWrapper.style.left = "0";
        outerWrapper.style.right = "0";
        outerWrapper.style.bottom = "0";
        outerWrapper.style.overflow = "hidden";
        outerWrapper.style.touchAction = "none";

        // Insert the outer wrapper
        if (canvasContainer.parentElement) {
            canvasContainer.parentElement.insertBefore(
                outerWrapper,
                canvasContainer,
            );
            outerWrapper.appendChild(canvasContainer);
        }

        // Style the canvas container for transforms
        canvasContainer.style.position = "absolute";
        canvasContainer.style.transformOrigin = "0 0";
        canvasContainer.style.willChange = "transform";

        // CRITICAL: Add CSS to the whole document to prevent default zoom behaviors
        // This is what modern design tools do - they prevent all browser-level zoom gestures
        this.addNoZoomCSSToDocument();

        // Initialize event handlers with professional design application style approach
        this.setupModernDesignToolGestureHandlers(
            outerWrapper,
            canvasContainer,
        );
    }

    /**
     * Add CSS to prevent browser zoom gestures - critical for macOS trackpads
     * This is what professional design applications do to prevent browser from interpreting trackpad gestures as zoom
     */
    private addNoZoomCSSToDocument() {
        // Create a style element
        const style = document.createElement("style");
        style.textContent = `
            /* Prevent pinch zoom on the entire document */
            html, body {
                touch-action: pan-x pan-y;
                -ms-touch-action: pan-x pan-y;
                -webkit-touch-callout: none;
                -webkit-user-select: none;
                -moz-user-select: none;
                -ms-user-select: none;
                user-select: none;
                overflow: hidden;
                height: 100%;
                width: 100%;
                position: fixed;
            }
            /* Explicitly prevent browser zoom on trackpad gestures */
            .fabric-outer-container {
                touch-action: none !important;
                -ms-touch-action: none !important;
            }
        `;
        document.head.appendChild(style);

        // Disable zoom on meta+wheel and ctrl+wheel
        window.addEventListener(
            "wheel",
            (e) => {
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                }
            },
            { passive: false },
        );

        // Add viewport meta tag to prevent mobile pinch zoom
        const meta = document.createElement("meta");
        meta.name = "viewport";
        meta.content =
            "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no";
        document.head.appendChild(meta);
    }

    /**
     * Set up all gesture handlers using the modern design tool approach
     */
    private setupModernDesignToolGestureHandlers(
        outerContainer: HTMLElement,
        canvasContainer: HTMLElement,
    ) {
        // ===== DIRECT DOM EVENT HANDLERS =====
        // Modern design tools use direct wheel event handling from the DOM rather than relying on library events

        // CRITICAL: This is the most important part for macOS - handle wheel events at the capture phase
        // This ensures we get them before any other handlers
        outerContainer.addEventListener("wheel", this.handleMacOSTrackpad, {
            capture: true, // Get events during capture phase (before they reach inner elements)
            passive: false, // Allows us to call preventDefault()
        });

        // Normal wheel fallback for non-macOS
        outerContainer.addEventListener("wheel", this.handleContainerWheel, {
            passive: false,
        });

        // ===== MOUSE DRAG EVENTS =====
        outerContainer.addEventListener(
            "mousedown",
            this.handleContainerMouseDown,
        );
        window.addEventListener("mousemove", this.handleContainerMouseMove);
        window.addEventListener("mouseup", this.handleContainerMouseUp);

        // ===== TOUCH EVENTS =====
        outerContainer.addEventListener(
            "touchstart",
            this.handleContainerTouchStart,
            { passive: false },
        );
        outerContainer.addEventListener(
            "touchmove",
            this.handleContainerTouchMove,
            { passive: false },
        );
        outerContainer.addEventListener(
            "touchend",
            this.handleContainerTouchEnd,
        );

        // ===== UI CONTROLS =====
        // Add zoom percentage display
        this.updateZoomPercentageDisplay();
    }

    /**
     * The most critical handler: Specially handle macOS trackpad events in capture phase
     * This is similar to how professional design applications handle trackpad gestures
     */
    private handleMacOSTrackpad = (e: WheelEvent) => {
        // Only needed for macOS
        if (!this.isMacOS()) return;

        // Check if this looks like a macOS trackpad gesture
        const isMacTrackpadGesture = this.isMacTrackpadGesture(e);

        if (isMacTrackpadGesture) {
            // Aggressively prevent default for any trackpad gesture
            e.preventDefault();
            e.stopPropagation();

            // Disable object caching for better performance
            if (this.staticGridRef.objectCaching) {
                this.staticGridRef.objectCaching = false;
            }

            // ONLY allow zoom if explicitly using meta/ctrl key
            if (e.metaKey || e.ctrlKey) {
                // Apply a smoother, less aggressive zoom factor
                const smoothZoomFactor =
                    1 +
                    (e.deltaY < 0
                        ? this.zoomSensitivity
                        : -this.zoomSensitivity);
                this.zoomContainer(smoothZoomFactor, e.clientX, e.clientY);
            }
            // Otherwise force ALL trackpad gestures to be interpreted as pan
            else {
                // Apply the pan with sensitivity adjustment
                this.panContainer(
                    -e.deltaX * this.trackpadPanSensitivity,
                    -e.deltaY * this.trackpadPanSensitivity,
                );
            }

            // Re-enable caching after a delay
            clearTimeout(this._zoomTimeout);
            this._zoomTimeout = setTimeout(() => {
                if (this.staticGridRef && !this.staticGridRef.objectCaching) {
                    this.staticGridRef.objectCaching = true;
                    this.updateFabricViewportFromContainer();
                    this.requestRenderAll();
                }
            }, 100);
        }
    };

    /**
     * Detect if this event is from a macOS trackpad
     * Based on how professional design applications detect trackpad gestures
     */
    private isMacTrackpadGesture(e: WheelEvent): boolean {
        // Must be on macOS
        if (!this.isMacOS()) return false;

        // Trackpad mode must be enabled
        if (!this.trackpadModeEnabled) return false;

        // Most macOS trackpad events have deltaMode=0 (pixels)
        const isPixelMode = e.deltaMode === 0;

        // Look for small, precise delta values (trackpads produce these)
        const isPreciseMovement =
            Math.abs(e.deltaY) < 10 || Math.abs(e.deltaX) < 10;

        // Trackpads typically produce both X and Y values together
        const isTwoDimensional =
            Math.abs(e.deltaX) > 0 && Math.abs(e.deltaY) > 0;

        // Return true if this looks like a macOS trackpad gesture
        return isPixelMode && (isPreciseMovement || isTwoDimensional);
    }

    /**
     * Apply pan to the container using CSS transform
     * Enhanced for professional design application style smooth motion
     */
    public panContainer(deltaX: number, deltaY: number) {
        if (!this.cssZoomWrapper) return;

        // Apply inertia damping for smoother, more controlled motion
        // This makes small movements more precise while still allowing larger movements
        const applyInertia = (delta: number): number => {
            const sign = Math.sign(delta);
            const absDelta = Math.abs(delta);

            // Enhanced damping for ultra-smooth movements
            // More controlled and gentle for all ranges of motion
            if (absDelta < 3) {
                return delta * 0.6; // Very small movements - more controlled
            } else if (absDelta < 10) {
                return sign * (absDelta * 0.5); // Small movements - smoother
            } else if (absDelta < 30) {
                return sign * (absDelta * 0.4); // Medium movements
            } else {
                return sign * (absDelta * 0.3); // Larger movements - much gentler
            }
        };

        // Apply the inertia function to smooth out movements
        const smoothDeltaX = applyInertia(deltaX);
        const smoothDeltaY = applyInertia(deltaY);

        // Update transform values with the smoothed deltas
        this.transformValues.translateX += smoothDeltaX;
        this.transformValues.translateY += smoothDeltaY;

        // Apply the transform with a subtle transition for smoother movement
        this.cssZoomWrapper.style.transition =
            "transform 0.08s cubic-bezier(0.33, 1, 0.68, 1)";
        this.applyContainerTransform();

        // Immediately update the Fabric viewport for better interaction
        this.updateFabricViewportFromContainer();

        // Reset transition after a short delay
        setTimeout(() => {
            if (this.cssZoomWrapper) {
                this.cssZoomWrapper.style.transition = "none";
            }
        }, 80);
    }

    /**
     * Handle wheel events for both zooming and panning
     */
    private handleContainerWheel = (e: WheelEvent) => {
        e.preventDefault();
        e.stopPropagation();

        // Disable object caching during transformation
        if (this.staticGridRef.objectCaching) {
            this.staticGridRef.objectCaching = false;
        }

        // Detect platform and input method
        const isMac = this.isMacOS();

        // On Mac, treat vertical gestures as panning by default unless modifier keys are pressed
        if (isMac && this.trackpadModeEnabled) {
            // If holding Ctrl/Cmd, handle as zoom regardless of platform
            if (e.ctrlKey || e.metaKey) {
                // Use smoother zoom factor
                const smoothZoomFactor =
                    1 +
                    (e.deltaY < 0
                        ? this.zoomSensitivity
                        : -this.zoomSensitivity);
                this.zoomContainer(smoothZoomFactor, e.clientX, e.clientY);
            } else {
                // Otherwise, treat as pan with sensitivity adjustment
                this.panContainer(
                    -e.deltaX * this.trackpadPanSensitivity,
                    -e.deltaY * this.trackpadPanSensitivity,
                );
            }
        }
        // Standard behavior for other platforms
        else {
            if (e.ctrlKey || e.metaKey) {
                // Zoom with ctrl/meta key - smoother factor
                const smoothZoomFactor =
                    1 +
                    (e.deltaY < 0
                        ? this.zoomSensitivity
                        : -this.zoomSensitivity);
                this.zoomContainer(smoothZoomFactor, e.clientX, e.clientY);
            } else {
                // Pan without modifier keys - with standard sensitivity
                this.panContainer(
                    -e.deltaX * this.panSensitivity,
                    -e.deltaY * this.panSensitivity,
                );
            }
        }

        // Re-enable caching after a delay
        clearTimeout(this._zoomTimeout);
        this._zoomTimeout = setTimeout(() => {
            if (this.staticGridRef && !this.staticGridRef.objectCaching) {
                this.staticGridRef.objectCaching = true;
                this.updateFabricViewportFromContainer();
                this.requestRenderAll();
            }
        }, 100);
    };

    /**
     * Handle mousedown on the container
     */
    private handleContainerMouseDown = (e: MouseEvent) => {
        // Only handle middle mouse button or Alt+click for panning
        if (e.button === 1 || e.altKey) {
            e.preventDefault();
            this.isPanning = true;
            this.lastPosX = e.clientX;
            this.lastPosY = e.clientY;

            // Change cursor
            document.body.style.cursor = "grabbing";
        }
    };

    /**
     * Handle mousemove for panning
     */
    private handleContainerMouseMove = (e: MouseEvent) => {
        if (!this.isPanning) return;

        const deltaX = e.clientX - this.lastPosX;
        const deltaY = e.clientY - this.lastPosY;

        this.panContainer(deltaX, deltaY);

        this.lastPosX = e.clientX;
        this.lastPosY = e.clientY;
    };

    /**
     * Handle mouseup to end panning
     */
    private handleContainerMouseUp = () => {
        if (this.isPanning) {
            this.isPanning = false;
            document.body.style.cursor = "";
            this.updateFabricViewportFromContainer();
        }
    };

    /**
     * Handle touch start for pan/zoom
     */
    private handleContainerTouchStart = (e: TouchEvent) => {
        e.preventDefault();

        // Two-finger gesture for pinch zoom
        if (e.touches.length === 2) {
            const touch1 = e.touches[0];
            const touch2 = e.touches[1];

            // Calculate initial distance for pinch-zoom
            this.initialPinchDistance = Math.hypot(
                touch2.clientX - touch1.clientX,
                touch2.clientY - touch1.clientY,
            );

            // Calculate center point
            this.lastPosX = (touch1.clientX + touch2.clientX) / 2;
            this.lastPosY = (touch1.clientY + touch2.clientY) / 2;
        }
        // Single finger for panning
        else if (e.touches.length === 1) {
            this.isPanning = true;
            this.lastPosX = e.touches[0].clientX;
            this.lastPosY = e.touches[0].clientY;
        }
    };

    /**
     * Handle touch move for pan/zoom
     */
    private handleContainerTouchMove = (e: TouchEvent) => {
        e.preventDefault();

        // Pinch-zoom gesture with two fingers
        if (e.touches.length === 2) {
            const touch1 = e.touches[0];
            const touch2 = e.touches[1];

            // Calculate current distance
            const currentDistance = Math.hypot(
                touch2.clientX - touch1.clientX,
                touch2.clientY - touch1.clientY,
            );

            // Calculate center point
            const centerX = (touch1.clientX + touch2.clientX) / 2;
            const centerY = (touch1.clientY + touch2.clientY) / 2;

            // Calculate delta for panning
            const deltaX = centerX - this.lastPosX;
            const deltaY = centerY - this.lastPosY;

            // Apply zoom if distance changed significantly
            if (Math.abs(currentDistance - this.initialPinchDistance) > 10) {
                const zoomFactor = currentDistance / this.initialPinchDistance;
                this.zoomContainer(zoomFactor, centerX, centerY);
                this.initialPinchDistance = currentDistance;
            }

            // Apply pan
            this.panContainer(deltaX, deltaY);

            // Update reference point
            this.lastPosX = centerX;
            this.lastPosY = centerY;
        }
        // Single finger panning
        else if (e.touches.length === 1 && this.isPanning) {
            const touch = e.touches[0];
            const deltaX = touch.clientX - this.lastPosX;
            const deltaY = touch.clientY - this.lastPosY;

            this.panContainer(deltaX, deltaY);

            this.lastPosX = touch.clientX;
            this.lastPosY = touch.clientY;
        }
    };

    /**
     * Handle touch end
     */
    private handleContainerTouchEnd = () => {
        this.isPanning = false;
        this.initialPinchDistance = 0;
        this.updateFabricViewportFromContainer();
    };

    /**
     * Apply zoom to the container using CSS transform with strict limits
     * Enhanced with smoother transitions for professional design application feel
     */
    private zoomContainer(factor: number, clientX: number, clientY: number) {
        if (!this.cssZoomWrapper || !this.cssZoomWrapper.parentElement) return;

        // Get container rect to calculate relative position
        const rect = this.cssZoomWrapper.parentElement.getBoundingClientRect();

        // Calculate point position relative to container
        const x = clientX - rect.left;
        const y = clientY - rect.top;

        // Store current scale for calculation
        const prevScale = this.transformValues.scale;

        // Calculate new scale with strict limits
        // Apply a stronger damping factor for ultra-smooth zooming
        const dampedFactor =
            factor > 1
                ? 1 + (factor - 1) * 0.5 // More dampening for zoom in
                : 1 - (1 - factor) * 0.5; // More dampening for zoom out

        let newScale = prevScale * dampedFactor;

        // Apply strict zoom limits
        const isAtMinZoom = prevScale <= this.MIN_ZOOM && factor < 1;
        const isAtMaxZoom = prevScale >= this.MAX_ZOOM && factor > 1;

        // Enforce limits and provide visual feedback when limits are reached
        if (isAtMinZoom) {
            newScale = this.MIN_ZOOM;
            this.showZoomLimitFeedback("You've reached maximum zoom out");
            return; // Don't apply any more zoom
        } else if (isAtMaxZoom) {
            newScale = this.MAX_ZOOM;
            this.showZoomLimitFeedback("You've reached maximum zoom in");
            return; // Don't apply any more zoom
        }

        // Final clamp to ensure we never exceed limits
        newScale = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, newScale));

        // Skip if scale change is too small
        if (Math.abs(newScale - prevScale) < 0.0001) return;

        // Update origin point for the transform
        this.transformValues.originX = x;
        this.transformValues.originY = y;

        // Adjust translation to zoom toward the cursor point
        const scaleFactor = newScale / prevScale;
        this.transformValues.translateX =
            x - (x - this.transformValues.translateX) * scaleFactor;
        this.transformValues.translateY =
            y - (y - this.transformValues.translateY) * scaleFactor;

        // Update scale value
        this.transformValues.scale = newScale;

        // Apply the transform with an improved easing curve for smoother zoom feeling
        // Longer duration and better easing curve for professional design application smoothness
        this.cssZoomWrapper.style.transition =
            "transform 0.15s cubic-bezier(0.25, 0.1, 0.25, 1)";
        this.applyContainerTransform();

        // Clear the transition after zoom is complete for responsive panning
        setTimeout(() => {
            if (this.cssZoomWrapper) {
                this.cssZoomWrapper.style.transition = "none";
            }
        }, 150);

        // Update zoom percentage in UI if we have a zoom display
        this.updateZoomPercentageDisplay();
    }

    /**
     * Show temporary visual feedback when user hits zoom limits
     */
    private showZoomLimitFeedback(message: string) {
        // Check if feedback element already exists
        let feedback = document.getElementById("zoom-limit-feedback");

        // Create if it doesn't exist
        if (!feedback) {
            feedback = document.createElement("div");
            feedback.id = "zoom-limit-feedback";
            feedback.style.position = "absolute";
            feedback.style.bottom = "60px";
            feedback.style.left = "50%";
            feedback.style.transform = "translateX(-50%)";
            feedback.style.backgroundColor = "rgba(0, 0, 0, 0.7)";
            feedback.style.color = "white";
            feedback.style.padding = "8px 12px";
            feedback.style.borderRadius = "4px";
            feedback.style.fontFamily = "sans-serif";
            feedback.style.fontSize = "14px";
            feedback.style.pointerEvents = "none";
            feedback.style.opacity = "0";
            feedback.style.transition = "opacity 0.2s ease-in-out";
            feedback.style.zIndex = "10000";
            document.body.appendChild(feedback);
        }

        // Update message and show
        feedback.textContent = message;
        feedback.style.opacity = "1";

        // Hide after 1.5 seconds
        setTimeout(() => {
            if (feedback) feedback.style.opacity = "0";
        }, 1500);
    }

    /**
     * Update zoom percentage display in UI
     */
    private updateZoomPercentageDisplay() {
        // Remove any existing zoom controls to avoid duplicates
        if (!this.fieldProperties || !this.cssZoomWrapper) return;
        let oldZoomControls = document.getElementById(
            "workspace-zoom-controls",
        );
        if (oldZoomControls && oldZoomControls.parentElement) {
            oldZoomControls.parentElement.removeChild(oldZoomControls);
        }

        // Get or create the workspace zoom controls container
        let zoomControlsContainer = document.createElement("div");
        zoomControlsContainer.id = "workspace-zoom-controls";
        zoomControlsContainer.title = "Workspace Zoom Controls";
        zoomControlsContainer.style.position = "absolute";
        zoomControlsContainer.style.right = "20px";
        zoomControlsContainer.style.zIndex = "1000";
        zoomControlsContainer.style.display = "flex";
        zoomControlsContainer.style.alignItems = "center";
        zoomControlsContainer.style.backgroundColor = "white";
        zoomControlsContainer.style.boxShadow = "0 2px 8px rgba(0, 0, 0, 0.2)";
        zoomControlsContainer.style.borderRadius = "4px";
        zoomControlsContainer.style.padding = "4px";
        zoomControlsContainer.style.fontFamily = "sans-serif";

        // Create zoom out button
        const zoomOutButton = document.createElement("button");
        zoomOutButton.innerHTML = "−";
        zoomOutButton.style.width = "28px";
        zoomOutButton.style.height = "28px";
        zoomOutButton.style.border = "none";
        zoomOutButton.style.backgroundColor = "white";
        zoomOutButton.style.borderRadius = "4px";
        zoomOutButton.style.cursor = "pointer";
        zoomOutButton.style.fontSize = "18px";
        zoomOutButton.style.display = "flex";
        zoomOutButton.style.alignItems = "center";
        zoomOutButton.style.justifyContent = "center";
        zoomOutButton.title = "Zoom out";
        zoomOutButton.addEventListener("click", () => {
            const centerX = window.innerWidth / 2;
            const centerY = window.innerHeight / 2;
            const zoomFactor = 0.8;
            this.zoomContainer(zoomFactor, centerX, centerY);
        });
        zoomOutButton.addEventListener("mouseenter", () => {
            zoomOutButton.style.backgroundColor = "#f5f5f5";
        });
        zoomOutButton.addEventListener("mouseleave", () => {
            zoomOutButton.style.backgroundColor = "white";
        });

        // Create zoom percentage display as a button
        const zoomDisplay = document.createElement("button");
        zoomDisplay.id = "zoom-percentage-display";
        zoomDisplay.style.padding = "0 8px";
        zoomDisplay.style.fontSize = "12px";
        zoomDisplay.style.minWidth = "40px";
        zoomDisplay.style.textAlign = "center";
        zoomDisplay.style.height = "28px";
        zoomDisplay.style.border = "none";
        zoomDisplay.style.backgroundColor = "white";
        zoomDisplay.style.borderRadius = "4px";
        zoomDisplay.style.cursor = "pointer";
        zoomDisplay.style.fontWeight = "bold";
        zoomDisplay.style.display = "flex";
        zoomDisplay.style.alignItems = "center";
        zoomDisplay.style.justifyContent = "center";
        zoomDisplay.title = "Click to fit field to view (100%)";
        zoomDisplay.addEventListener("click", () => {
            this.fitToScreen();
        });
        zoomDisplay.addEventListener("mouseenter", () => {
            zoomDisplay.style.backgroundColor = "#f5f5f5";
        });
        zoomDisplay.addEventListener("mouseleave", () => {
            zoomDisplay.style.backgroundColor = "white";
        });
        zoomDisplay.addEventListener("mousedown", () => {
            zoomDisplay.style.backgroundColor = "#e0e0e0";
        });
        zoomDisplay.addEventListener("mouseup", () => {
            zoomDisplay.style.backgroundColor = "#f5f5f5";
        });

        // Create zoom in button
        const zoomInButton = document.createElement("button");
        zoomInButton.innerHTML = "+";
        zoomInButton.style.width = "28px";
        zoomInButton.style.height = "28px";
        zoomInButton.style.border = "none";
        zoomInButton.style.backgroundColor = "white";
        zoomInButton.style.borderRadius = "4px";
        zoomInButton.style.cursor = "pointer";
        zoomInButton.style.fontSize = "18px";
        zoomInButton.style.display = "flex";
        zoomInButton.style.alignItems = "center";
        zoomInButton.style.justifyContent = "center";
        zoomInButton.title = "Zoom in";
        zoomInButton.addEventListener("click", () => {
            const centerX = window.innerWidth / 2;
            const centerY = window.innerHeight / 2;
            const zoomFactor = 1.25;
            this.zoomContainer(zoomFactor, centerX, centerY);
        });
        zoomInButton.addEventListener("mouseenter", () => {
            zoomInButton.style.backgroundColor = "#f5f5f5";
        });
        zoomInButton.addEventListener("mouseleave", () => {
            zoomInButton.style.backgroundColor = "white";
        });

        // Remove fit to screen button and separator
        // Only use: zoomOutButton, zoomDisplay, zoomInButton
        zoomControlsContainer.appendChild(zoomOutButton);
        zoomControlsContainer.appendChild(zoomDisplay);
        zoomControlsContainer.appendChild(zoomInButton);

        // Try to position above the timeline if it exists
        const timeline = document.getElementById("timeline");
        let parentForControls: HTMLElement | null = null;
        let bottomPx = 20;
        if (timeline && timeline.parentElement) {
            parentForControls = timeline.parentElement;
            // Get timeline height (including margin/padding)
            const timelineRect = timeline.getBoundingClientRect();
            // Get parent rect to calculate offset
            const parentRect = parentForControls.getBoundingClientRect();
            // Place controls above the timeline, relative to parent
            bottomPx = parentRect.bottom - timelineRect.top + 20;
            zoomControlsContainer.style.bottom = `${bottomPx}px`;
            parentForControls.appendChild(zoomControlsContainer);
        } else {
            // Fallback to .canvas-upper or body
            const upperCanvas = document.querySelector(".canvas-upper");
            if (upperCanvas) {
                if (getComputedStyle(upperCanvas).position === "static") {
                    (upperCanvas as HTMLElement).style.position = "relative";
                }
                zoomControlsContainer.style.bottom = "80px";
                upperCanvas.appendChild(zoomControlsContainer);
            } else {
                zoomControlsContainer.style.position = "fixed";
                zoomControlsContainer.style.bottom = "80px";
                document.body.appendChild(zoomControlsContainer);
            }
        }

        // Listen for window resize to reposition dynamically
        window.addEventListener(
            "resize",
            () => {
                this.updateZoomPercentageDisplay();
            },
            { once: true },
        );

        // Calculate fit-to-field scale
        let fitScale = 1;
        if (this.cssZoomWrapper) {
            const fieldWidth = this.fieldProperties.width;
            const fieldHeight = this.fieldProperties.height;
            const viewportWidth = window.innerWidth;
            const viewportHeight = window.innerHeight;
            const margin = 40;
            const scaleX = (viewportWidth - margin) / fieldWidth;
            const scaleY = (viewportHeight - margin) / fieldHeight;
            fitScale = Math.min(scaleX, scaleY) * 0.8; // 80% of the viewport
        }
        const percentOfFit = Math.round(
            (this.transformValues.scale / fitScale) * 100,
        );
        const zoomDisplayElem = document.getElementById(
            "zoom-percentage-display",
        );
        if (zoomDisplayElem) {
            zoomDisplayElem.textContent = `${percentOfFit}%`;
        }
    }

    /**
     * Reset zoom and pan to default
     */
    private resetZoom() {
        // Reset to default values
        this.transformValues.scale = 1;
        this.transformValues.translateX = 0;
        this.transformValues.translateY = 0;

        // Apply transform
        this.applyContainerTransform();

        // Update Fabric.js viewport
        this.updateFabricViewportFromContainer();

        // Update zoom percentage display
        this.updateZoomPercentageDisplay();
    }

    /**
     * Auto-fit the field to the viewport with a margin
     */
    private fitToScreen() {
        if (!this.cssZoomWrapper) return;

        // Get field dimensions
        const fieldWidth = this.fieldProperties.width;
        const fieldHeight = this.fieldProperties.height;

        // Get viewport dimensions
        const viewportWidth = window.innerWidth;
        const viewportHeight = window.innerHeight;

        // Calculate the scale needed to fit the field with a margin
        const margin = 40; // 20px margin on each side
        const scaleX = (viewportWidth - margin) / fieldWidth;
        const scaleY = (viewportHeight - margin) / fieldHeight;
        let scale = Math.min(scaleX, scaleY) * 0.8; // 80% of the viewport
        // Enforce zoom limits
        scale = Math.max(this.MIN_ZOOM, Math.min(this.MAX_ZOOM, scale));

        // Center the geometric center of the field
        const centerFieldX = fieldWidth / 2;
        const centerFieldY = fieldHeight / 2;
        const centerViewportX = viewportWidth / 2;
        const centerViewportY = viewportHeight / 2;
        const translateX = centerViewportX - centerFieldX * scale;
        const translateY = centerViewportY - centerFieldY * scale;

        // Set new transform values
        this.transformValues.scale = scale;
        this.transformValues.translateX = translateX;
        this.transformValues.translateY = translateY;

        // Apply transform with transition for smooth animation
        this.cssZoomWrapper.style.transition =
            "transform 0.3s cubic-bezier(0.2, 0, 0.2, 1)";
        this.applyContainerTransform();

        // Clear transition after animation completes
        setTimeout(() => {
            if (this.cssZoomWrapper) {
                this.cssZoomWrapper.style.transition = "none";
            }
        }, 300);

        // Update Fabric.js viewport
        this.updateFabricViewportFromContainer();

        // Update zoom percentage display
        this.updateZoomPercentageDisplay();
    }

    /**
     * Apply transform values to the container
     * Modified to use transitions specified by calling functions instead
     */
    private applyContainerTransform() {
        if (!this.cssZoomWrapper) return;

        const { translateX, translateY, scale } = this.transformValues;

        // Apply the transform without overriding transition
        // (Each calling function now sets its own appropriate transition timing)
        this.cssZoomWrapper.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
    }

    /**
     * Update Fabric.js viewport to match the CSS container transform
     * This ensures object interactions work correctly after CSS transforms
     */
    public updateFabricViewportFromContainer() {
        if (!this.cssZoomWrapper) return;

        const { scale, translateX, translateY } = this.transformValues;

        // Update Fabric viewport transform to match the container's CSS transform
        if (this.viewportTransform) {
            this.viewportTransform[0] = scale; // scaleX
            this.viewportTransform[3] = scale; // scaleY
            this.viewportTransform[4] = translateX; // translateX
            this.viewportTransform[5] = translateY; // translateY

            // Apply transform to Fabric
            this.setViewportTransform(this.viewportTransform);
        }
    }

    /******************* INSTANCE METHODS ******************/
    /**
     * Refreshes the size of the canvas to fit the window.
     */
    refreshCanvasSize() {
        // Only set dimensions if the canvas element exists
        if (this.getElement()) {
            this.setWidth(window.innerWidth);
            this.setHeight(window.innerHeight);
        }
    }

    /**
     * Set the listeners on the canvas. This should be changed based on the cursor mode.
     *
     * @param newListeners The listeners to set on the canvas
     */
    setListeners(newListeners: CanvasListeners) {
        this._listeners?.cleanupListeners();

        this._listeners = newListeners;
        this._listeners.initiateListeners();

        // Update cursor based on canvas panning setting
        if (!this._uiSettings.mouseSettings.enableCanvasPanning) {
            this.defaultCursor = "default";
            this.moveCursor = "default";
        } else {
            this.defaultCursor = "grab";
            this.moveCursor = "grabbing";
        }
    }

    /**
     * Sets given object as the only active object on canvas
     * This is an overload of the fabric.Canvas method to set the lockMovementX and lockMovementY properties
     *
     * @param object — Object to set as an active one
     * @param e — Event (passed along when firing "object:selected")
     * @return — thisArg
     */
    setActiveObject(object: fabric.Object, e?: Event): fabric.Canvas {
        object.lockMovementX = this.uiSettings.lockX;
        object.lockMovementY = this.uiSettings.lockY;
        return super.setActiveObject(object, e);
    }

    resetCursorsToDefault = () => {
        this.setCursor("default");
        this.defaultCursor = "default";
        this.moveCursor = "move";
        this.notAllowedCursor = "not-allowed";
        this.freeDrawingCursor = "crosshair";
    };

    /******* Marcher Functions *******/
    /**
     * Brings all control points of the marcher shapes to the front of the canvas.
     * This ensures the control points are always visible and on top of the marcher shapes.
     */
    bringAllControlPointsTooFront() {
        // Put all of the control points to the front if they exist
        for (const marcherShape of this.marcherShapes) {
            marcherShape.controlPoints.forEach((controlPoint) => {
                controlPoint.bringToFront();
            });
        }
    }

    /**
     * Renders the marcher shapes on the canvas based on the provided shape pages.
     * This method handles adding new shapes, updating existing shapes, and removing
     * shapes that are no longer present in the shape pages.
     *
     * @param shapePages - An array of shape pages containing the SVG paths to render.
     */
    renderMarcherShapes({ shapePages }: { shapePages: ShapePage[] }) {
        const existingMarcherShapeMap = new Map(
            this.marcherShapes.map((mp) => [mp.shapePage.shape_id, mp]),
        );

        // Remove shapes that no longer exist
        const newShapeIds = new Set(shapePages.map((sp) => sp.shape_id));
        const removedShapeIds = new Set();
        for (const existingMarcherShape of existingMarcherShapeMap) {
            // The shape is no longer present in the shape pages. Remove it.
            if (!newShapeIds.has(existingMarcherShape[0])) {
                removedShapeIds.add(existingMarcherShape[0]);
                existingMarcherShape[1].destroy();
            }
        }
        if (removedShapeIds.size !== 0) {
            this.marcherShapes = this.marcherShapes.filter(
                (ms) => !removedShapeIds.has(ms.shapePage.shape_id),
            );
        }

        for (const shapePage of shapePages) {
            const existingMarcherShape = existingMarcherShapeMap.get(
                shapePage.shape_id,
            );
            if (existingMarcherShape) {
                existingMarcherShape.setShapePage(shapePage);
                existingMarcherShape.refreshMarchers();
            } else {
                this.marcherShapes.push(
                    new MarcherShape({
                        canvas: this,
                        shapePage,
                    }),
                );
            }
        }
    }
    /**
     * Render the given marcherPages on the canvas
     *
     * @param currentMarcherPages All of the marcher pages (must be filtered by the intended page)
     * @param allMarchers All marchers in the drill
     */
    renderMarchers = async ({
        currentMarcherPages,
        allMarchers,
    }: {
        currentMarcherPages: MarcherPage[];
        allMarchers: Marcher[];
    }) => {
        CanvasMarcher.theme = this.fieldProperties.theme;

        const sectionAppearances =
            await SectionAppearance.getSectionAppearances();

        // Get the canvas marchers on the canvas
        const canvasMarchersMap = new Map<number, CanvasMarcher>(
            this.getCanvasMarchers().map((m) => [m.marcherObj.id, m]),
        );
        const allMarchersMap = new Map<number, Marcher>(
            allMarchers.map((m) => [m.id, m]),
        );

        for (const marcherPage of currentMarcherPages) {
            const curCanvasMarcher = canvasMarchersMap.get(
                marcherPage.marcher_id,
            );
            // Marcher does not exist on the Canvas, create a new one
            if (!curCanvasMarcher) {
                const curMarcher = allMarchersMap.get(marcherPage.marcher_id);
                if (!curMarcher) {
                    console.error(
                        "Marcher object not found in the store for given MarcherPage  - renderMarchers: Canvas.tsx",
                        marcherPage,
                    );
                    continue;
                }

                const sectionAppearance = getSectionAppearance(
                    curMarcher.section,
                    sectionAppearances,
                );

                this.add(
                    new CanvasMarcher({
                        marcher: curMarcher,
                        marcherPage,
                        sectionAppearance,
                    }),
                );
            }
            // Marcher exists on the Canvas, move it to the new location if it has changed
            else {
                curCanvasMarcher.setMarcherCoords(marcherPage);
            }
        }

        const marcherPageMarcherIds: Set<number> = new Set(
            currentMarcherPages.map((marcherPage) => marcherPage.marcher_id),
        );

        // Check for any canvas marchers that are no longer in the current marcher pages
        if (marcherPageMarcherIds.size !== canvasMarchersMap.size) {
            canvasMarchersMap.forEach((canvasMarcher, marcherId) => {
                if (!marcherPageMarcherIds.has(marcherId)) {
                    this.remove(canvasMarcher);
                }
            });
        }

        if (this._listeners && this._listeners.refreshMarchers)
            this._listeners?.refreshMarchers();

        this.bringAllControlPointsTooFront();
        this.requestRenderAll();
    };

    /**
     * Reset all marchers on the canvas to the positions defined in their MarcherPage objects
     */
    refreshMarchers = () => {
        const canvasMarchers = this.getCanvasMarchers();
        canvasMarchers.forEach((canvasMarcher) => {
            canvasMarcher.setMarcherCoords(canvasMarcher.marcherPage);
        });

        if (this._listeners && this._listeners.refreshMarchers)
            this._listeners?.refreshMarchers();

        this.requestRenderAll();
    };

    /**
     * Brings all of the canvasMarchers to the front of the canvas
     */
    sendCanvasMarchersToFront = () => {
        // Get the canvas marchers on the canvas
        const curCanvasMarchers: CanvasMarcher[] = this.getCanvasMarchers();

        curCanvasMarchers.forEach((canvasMarcher) => {
            this.bringToFront(canvasMarcher);
        });
        this.bringAllControlPointsTooFront();
    };

    /**
     * Render static marchers for the given page
     *
     * @param color The color of the static marchers (use rgba for transparency, e.g. "rgba(255, 255, 255, 1)")
     * @param intendedMarcherPages The marcher pages to render (must be filtered by the given page)
     * @param allMarchers All marchers in the drill
     * @returns The StaticCanvasMarcher objects created
     */
    renderStaticMarchers = ({
        color,
        intendedMarcherPages,
        allMarchers,
    }: {
        color: string;
        intendedMarcherPages: MarcherPage[];
        allMarchers: Marcher[];
    }) => {
        const createdStaticMarchers: StaticCanvasMarcher[] = [];
        intendedMarcherPages.forEach((marcherPage) => {
            const curMarcher = allMarchers.find(
                (marcher) => marcher.id === marcherPage.marcher_id,
            );
            if (!curMarcher) {
                console.error(
                    "Marcher object not found in the store for given MarcherPage - renderStaticMarchers: Canvas.tsx",
                    marcherPage,
                );
                return;
            }

            const staticMarcher = new StaticCanvasMarcher({
                marcherPage,
                color,
            });

            this.add(staticMarcher);
            createdStaticMarchers.push(staticMarcher);
        });
        this.requestRenderAll();

        return createdStaticMarchers;
    };

    /**
     * Remove the static canvas marchers from the canvas
     */
    removeStaticCanvasMarchers = () => {
        const curStaticCanvasMarchers = this.getStaticCanvasMarchers();

        curStaticCanvasMarchers.forEach((canvasMarcher) => {
            this.remove(canvasMarcher);
        });
        this.requestRenderAll();
    };

    /**
     * Renders all of the provided marcher lines on the canvas. Removes all other marcher lines first
     *
     * @param marcherLines All of the marcher lines in the drill (must be filtered by the given page, i.e. "MarcherLine.getMarcherLinesForPage()")
     */
    renderMarcherLines = ({
        marcherLines,
    }: {
        marcherLines: MarcherLine[];
    }) => {
        this.removeAllObjectsByType(MarcherLine);
        for (const marcherLine of marcherLines) {
            this.add(marcherLine);
        }
    };

    /**
     * Render the pathways from the selected page to the given one
     *
     * @param startPageMarcherPages the marcher pages to render the pathway from
     * @param endPageMarcherPages the marcher pages to render the pathway to
     * @param color color of the pathway
     */
    renderPathways = ({
        startPageMarcherPages,
        endPageMarcherPages,
        color,
        strokeWidth,
        dashed = false,
    }: {
        startPageMarcherPages: MarcherPage[];
        endPageMarcherPages: MarcherPage[];
        color: string;
        strokeWidth?: number;
        dashed?: boolean;
    }) => {
        const createdPathways: Pathway[] = [];
        endPageMarcherPages.forEach((previousMarcherPage) => {
            const selectedMarcherPage = startPageMarcherPages.find(
                (marcherPage) =>
                    marcherPage.marcher_id === previousMarcherPage.marcher_id,
            );
            // If the marcher does not exist on the selected page, return
            if (!selectedMarcherPage) {
                console.error(
                    "Selected marcher page not found - renderPathways: Canvas.tsx",
                    previousMarcherPage,
                );
                return;
            }

            const pathway = new Pathway({
                start: previousMarcherPage,
                end: selectedMarcherPage,
                color,
                strokeWidth,
                dashed,
                marcherId: previousMarcherPage.marcher_id,
            });
            createdPathways.push(pathway);
            this.add(pathway);
        });
        this.requestRenderAll();
        return createdPathways;
    };

    /**
     * Rounds an x and y coordinate to the nearest step multiple of the denominator
     *
     * @param x The x coordinate of the point
     * @param y The y coordinate of the point
     * @param denominator Nearest 1/n step. 4 -> 1/4 = nearest quarter step. 10 -> 1/10 = nearest tenth step. By default, 1 for nearest whole step
     * @returns The rounded x and y coordinates
     */
    getRoundedCoordinate = ({
        x,
        y,
        denominator = 1,
    }: {
        x: number;
        y: number;
        denominator?: number;
    }) => {
        const fakeMarcherPage: MarcherPage = {
            marcher_id: -1,
            x,
            y,
            id: -1,
            page_id: -1,
            id_for_html: "fake",
        };

        const response = CoordinateActions.getRoundCoordinates({
            marcherPages: [fakeMarcherPage],
            denominator,
            fieldProperties: this.fieldProperties,
            xAxis: true,
            yAxis: true,
        })[0];

        return { x: response.x, y: response.y };
    };

    /**
     * Builds and renders the grid for the field/stage based on the instance's field properties.
     *
     * @param gridLines Whether or not to include grid lines (every step)
     * @param halfLines Whether or not to include half lines (every 4 steps)
     */
    renderFieldGrid = () => {
        const gridLines = this.uiSettings?.gridLines ?? true;
        const halfLines = this.uiSettings?.halfLines ?? true;
        if (this.staticGridRef) this.remove(this.staticGridRef);
        this.staticGridRef = this.createFieldGrid({
            gridLines,
            halfLines,
        });
        this.staticGridRef.objectCaching = false;
        this.add(this.staticGridRef);
        this.sendToBack(this.staticGridRef);
        this.requestRenderAll();
    };

    /*********************** PRIVATE INSTANCE METHODS ***********************/
    /**
     * Apply pan with the given deltas
     */
    private applyPan(deltaX: number, deltaY: number): void {
        const vpt = this.viewportTransform;
        if (vpt) {
            vpt[4] -= deltaX;
            vpt[5] -= deltaY;
            this.requestRenderAll();
        }
    }

    /**
     * Apply zoom with the given delta at the given point
     */
    private applyZoom(deltaY: number, point: { x: number; y: number }): void {
        let zoom = this.getZoom();
        const zoomFactor = 0.9;
        zoom *= deltaY > 0 ? zoomFactor : 1 / zoomFactor;
        zoom = Math.min(Math.max(0.1, zoom), 20);
        this.zoomToPoint(point, zoom);
        this.requestRenderAll();
    }

    /**
     * Builds the grid for the field/stage based on the given field properties as a fabric.Group.
     *
     * @param gridLines Whether or not to include grid lines (every step)
     * @param halfLines Whether or not to include half lines (every 4 steps)
     * @returns
     */
    private createFieldGrid = ({
        gridLines = true,
        halfLines = true,
    }: {
        gridLines?: boolean;
        halfLines?: boolean;
        imageBuffer?: HTMLImageElement;
    }): fabric.Group => {
        const fieldArray: fabric.Object[] = [];
        const fieldWidth = this.fieldProperties.width;
        const fieldHeight = this.fieldProperties.height;
        const pixelsPerStep = this.fieldProperties.pixelsPerStep;
        const centerFrontPoint = this.fieldProperties.centerFrontPoint;

        // white background
        const background = new fabric.Rect({
            left: 0,
            top: 0,
            width: fieldWidth,
            height: fieldHeight,
            fill: rgbaToString(this.fieldProperties.theme.background),
            selectable: false,
            hoverCursor: "default",
        });
        fieldArray.push(background);

        if (
            this.fieldProperties.showFieldImage &&
            this._backgroundImage &&
            this._backgroundImage !== null
        ) {
            this.refreshBackgroundImageValues();
            if (!this._bgImageValues) {
                console.error(
                    "background image values not defined. This will cause strange image rendering",
                );
            } else {
                this._backgroundImage.scaleX = this._bgImageValues.scale;
                this._backgroundImage.scaleY = this._bgImageValues.scale;
                this._backgroundImage.left = this._bgImageValues.left;
                this._backgroundImage.top = this._bgImageValues.top;
            }
            fieldArray.push(this._backgroundImage);
        }

        // Render the grid lines either from the first checkpoint, or the first visible checkpoint if i's not an integer amount of steps away from the front point
        // This is to address when the front of the field isn't exactly with the grid
        const sortedYCheckpoints = this.fieldProperties.yCheckpoints.sort(
            (a, b) => b.stepsFromCenterFront - a.stepsFromCenterFront,
        );
        const firstVisibleYCheckpoint =
            this.fieldProperties.yCheckpoints.reduce(
                (prev, curr) => {
                    if (
                        curr.visible &&
                        curr.stepsFromCenterFront > prev.stepsFromCenterFront
                    )
                        return curr;
                    return prev;
                },
                sortedYCheckpoints[sortedYCheckpoints.length - 1],
            );
        let yCheckpointToStartGridFrom = sortedYCheckpoints[0];
        if (
            firstVisibleYCheckpoint.stepsFromCenterFront !== 0 &&
            firstVisibleYCheckpoint.stepsFromCenterFront % 1 !== 0
        )
            yCheckpointToStartGridFrom = firstVisibleYCheckpoint;

        // Grid lines
        if (gridLines) {
            const gridLineProps = {
                stroke: rgbaToString(this.fieldProperties.theme.tertiaryStroke),
                strokeWidth: FieldProperties.GRID_STROKE_WIDTH,
                selectable: false,
            };
            // X
            for (
                let i = centerFrontPoint.xPixels;
                i < fieldWidth;
                i += pixelsPerStep
            )
                fieldArray.push(
                    new fabric.Line([i, 0, i, fieldHeight], gridLineProps),
                );
            for (
                let i = centerFrontPoint.xPixels - pixelsPerStep;
                i > 0;
                i -= pixelsPerStep
            )
                fieldArray.push(
                    new fabric.Line([i, 0, i, fieldHeight], gridLineProps),
                );

            // Y

            for (
                let i =
                    centerFrontPoint.yPixels +
                    yCheckpointToStartGridFrom.stepsFromCenterFront *
                        pixelsPerStep;
                i > 0;
                i -= pixelsPerStep
            )
                fieldArray.push(
                    new fabric.Line([0, i, fieldWidth, i], gridLineProps),
                );
        }

        // Half lines
        if (halfLines) {
            const darkLineProps = {
                stroke: rgbaToString(
                    this.fieldProperties.theme.secondaryStroke,
                ),
                strokeWidth: FieldProperties.GRID_STROKE_WIDTH,
                selectable: false,
            };
            // X
            if (this.fieldProperties.halfLineXInterval) {
                fieldArray.push(
                    new fabric.Line(
                        [
                            centerFrontPoint.xPixels,
                            0,
                            centerFrontPoint.xPixels,
                            fieldHeight,
                        ],
                        darkLineProps,
                    ),
                );
                for (
                    let i =
                        centerFrontPoint.xPixels +
                        pixelsPerStep * this.fieldProperties.halfLineXInterval;
                    i < fieldWidth;
                    i += pixelsPerStep * this.fieldProperties.halfLineXInterval
                )
                    fieldArray.push(
                        new fabric.Line([i, 0, i, fieldHeight], darkLineProps),
                    );
                for (
                    let i =
                        centerFrontPoint.xPixels -
                        pixelsPerStep * this.fieldProperties.halfLineXInterval;
                    i > 0;
                    i -= pixelsPerStep * this.fieldProperties.halfLineXInterval
                )
                    fieldArray.push(
                        new fabric.Line([i, 0, i, fieldHeight], darkLineProps),
                    );
            }
            if (this.fieldProperties.halfLineYInterval) {
                // Y
                for (
                    let i =
                        centerFrontPoint.yPixels +
                        yCheckpointToStartGridFrom.stepsFromCenterFront *
                            pixelsPerStep -
                        pixelsPerStep * this.fieldProperties.halfLineYInterval;
                    i > 0;
                    i -= pixelsPerStep * this.fieldProperties.halfLineYInterval
                )
                    fieldArray.push(
                        new fabric.Line([0, i, fieldWidth, i], darkLineProps),
                    );
            }
        }

        // Yard lines, field numbers, and hashes
        const xCheckpointProps = {
            stroke: rgbaToString(this.fieldProperties.theme.primaryStroke),
            strokeWidth: FieldProperties.GRID_STROKE_WIDTH,
            selectable: false,
        };
        const yCheckpointProps = {
            stroke: rgbaToString(this.fieldProperties.theme.primaryStroke),
            strokeWidth: FieldProperties.GRID_STROKE_WIDTH * 3,
            selectable: false,
        };
        const ySecondaryCheckpointProps = {
            stroke: rgbaToString(this.fieldProperties.theme.secondaryStroke),
            strokeWidth: FieldProperties.GRID_STROKE_WIDTH * 2,
            selectable: false,
        };

        for (const xCheckpoint of this.fieldProperties.xCheckpoints) {
            if (!xCheckpoint.visible) continue;
            // X-Checkpoint (or yard lines)
            const x =
                centerFrontPoint.xPixels +
                xCheckpoint.stepsFromCenterFront * pixelsPerStep;
            fieldArray.push(
                new fabric.Line([x, 0, x, fieldHeight], xCheckpointProps),
            );

            // Y-Checkpoints (or hashes)
            if (this.fieldProperties.useHashes) {
                const hashWidth = 20;
                for (const yCheckpoint of this.fieldProperties.yCheckpoints) {
                    if (!yCheckpoint.visible) continue;
                    const y =
                        centerFrontPoint.yPixels +
                        yCheckpoint.stepsFromCenterFront * pixelsPerStep -
                        1;
                    let x1 = x - hashWidth / 2;
                    x1 = x1 < 0 ? 0 : x1;
                    let x2 = x + hashWidth / 2;
                    x2 = x2 > fieldWidth ? fieldWidth : x2;
                    fieldArray.push(
                        new fabric.Line(
                            [x1, y, x2 + 1, y],
                            yCheckpoint.useAsReference
                                ? yCheckpointProps
                                : ySecondaryCheckpointProps,
                        ),
                    );
                }
            }
        }

        if (!this.fieldProperties.useHashes) {
            for (const yCheckpoint of this.fieldProperties.yCheckpoints) {
                if (!yCheckpoint.visible) continue;
                // X-Checkpoint (or yard lines)
                const y =
                    centerFrontPoint.yPixels +
                    yCheckpoint.stepsFromCenterFront * pixelsPerStep;
                fieldArray.push(
                    new fabric.Line([0, y, fieldWidth, y], xCheckpointProps),
                );
            }
        }

        // Print labels for each checkpoint
        // These are different from the yard numbers and will always be visible
        const labelProps: fabric.TextOptions = {
            fontSize: 20,
            fill: rgbaToString(this.fieldProperties.theme.externalLabel),
            selectable: false,
            strokeWidth: 0.5,
            fontFamily: "mono",
        };
        for (const xCheckpoint of this.fieldProperties.xCheckpoints) {
            if (!xCheckpoint.visible) continue;
            const x =
                centerFrontPoint.xPixels +
                xCheckpoint.stepsFromCenterFront * pixelsPerStep;
            const bottomY = centerFrontPoint.yPixels + 5;
            const topY = -25;
            const text = xCheckpoint.terseName;
            if (this.fieldProperties.bottomLabelsVisible)
                fieldArray.push(
                    new fabric.Text(text, {
                        left: x,
                        top: bottomY,
                        originX: "center",

                        ...labelProps,
                    }),
                );
            if (this.fieldProperties.topLabelsVisible)
                fieldArray.push(
                    new fabric.Text(text, {
                        left: x,
                        top: topY,
                        originX: "center",
                        ...labelProps,
                    }),
                );
        }
        for (const yCheckpoint of this.fieldProperties.yCheckpoints) {
            if (!yCheckpoint.visible) continue;
            const text = yCheckpoint.terseName;
            const y =
                centerFrontPoint.yPixels +
                yCheckpoint.stepsFromCenterFront * pixelsPerStep;
            const padding = 10;
            if (this.fieldProperties.leftLabelsVisible) {
                const newText = new fabric.Text(text, {
                    left: 0,
                    top: y,
                    originY: "center",
                    ...labelProps,
                });

                fieldArray.push(
                    new fabric.Text(text, {
                        left: 0 - newText.width! - padding,
                        top: y,
                        originY: "center",
                        ...labelProps,
                    }),
                );
            }
            if (this.fieldProperties.rightLabelsVisible)
                fieldArray.push(
                    new fabric.Text(text, {
                        left: fieldWidth + padding,
                        top: y,
                        originY: "center",
                        ...labelProps,
                    }),
                );
        }

        // Print yard line numbers if they exist
        const yardNumberCoordinates =
            this.fieldProperties.yardNumberCoordinates;
        if (
            yardNumberCoordinates.homeStepsFromFrontToInside !== undefined &&
            yardNumberCoordinates.homeStepsFromFrontToOutside !== undefined
        ) {
            const numberHeight =
                (yardNumberCoordinates.homeStepsFromFrontToInside -
                    yardNumberCoordinates.homeStepsFromFrontToOutside) *
                pixelsPerStep;
            const numberProps = {
                fontSize: numberHeight,
                fill: rgbaToString(this.fieldProperties.theme.fieldLabel),
                selectable: false,
                charSpacing: 160,
            };
            const yardNumberXOffset = 22;
            for (const xCheckpoint of this.fieldProperties.xCheckpoints) {
                // Yard line numbers
                const x =
                    centerFrontPoint.xPixels +
                    xCheckpoint.stepsFromCenterFront * pixelsPerStep;

                if (xCheckpoint.fieldLabel) {
                    if (
                        yardNumberCoordinates.homeStepsFromFrontToInside !==
                            undefined &&
                        yardNumberCoordinates.homeStepsFromFrontToOutside !==
                            undefined
                    ) {
                        // Home number
                        fieldArray.push(
                            new fabric.Text(xCheckpoint.fieldLabel, {
                                left: x - yardNumberXOffset,
                                top:
                                    centerFrontPoint.yPixels -
                                    yardNumberCoordinates.homeStepsFromFrontToInside *
                                        pixelsPerStep,
                                ...numberProps,
                            }),
                        );
                    }
                    if (
                        yardNumberCoordinates.awayStepsFromFrontToOutside !==
                            undefined &&
                        yardNumberCoordinates.awayStepsFromFrontToOutside !==
                            undefined
                    ) {
                        // Away number
                        fieldArray.push(
                            new fabric.Text(xCheckpoint.fieldLabel, {
                                left: x - yardNumberXOffset,
                                top:
                                    centerFrontPoint.yPixels -
                                    yardNumberCoordinates.awayStepsFromFrontToOutside *
                                        pixelsPerStep,
                                flipY: true,
                                flipX: true,
                                ...numberProps,
                            }),
                        );
                    }
                }
            }
        }

        // Border
        const borderWidth = FieldProperties.GRID_STROKE_WIDTH * 3;
        const borderOffset = 1 - borderWidth; // Offset to prevent clipping. Border hangs off the edge of the canvas
        const borderProps = {
            stroke: rgbaToString(this.fieldProperties.theme.primaryStroke),
            strokeWidth: borderWidth,
            selectable: false,
        };
        // Back line
        fieldArray.push(
            new fabric.Line(
                [
                    borderOffset,
                    borderOffset,
                    fieldWidth - borderOffset,
                    borderOffset,
                ],
                borderProps,
            ),
        );
        // Front line
        fieldArray.push(
            new fabric.Line(
                [
                    borderOffset,
                    fieldHeight,
                    fieldWidth - borderOffset + 1,
                    fieldHeight,
                ],
                borderProps,
            ),
        );
        // Left line
        fieldArray.push(
            new fabric.Line(
                [
                    borderOffset,
                    borderOffset,
                    borderOffset,
                    fieldHeight - borderOffset,
                ],
                borderProps,
            ),
        );
        // Right line
        fieldArray.push(
            new fabric.Line(
                [
                    fieldWidth,
                    borderOffset,
                    fieldWidth,
                    fieldHeight - borderOffset,
                ],
                borderProps,
            ),
        );

        return new fabric.Group(fieldArray, {
            selectable: false,
            hoverCursor: "default",
        });
    };

    /*********************** GENERAL UTILITIES ***********************/
    /**
     * Remove all objects of a specified type from the canvas
     *
     * @param type The type of object to remove (must be a subclass of fabric.Object)
     */
    removeAllObjectsByType<T extends fabric.Object>(
        type: new (...args: any[]) => T,
    ) {
        const objects = this.getObjectsByType(type);

        objects.forEach((obj) => this.remove(obj));

        this.requestRenderAll();
    }

    /*********************** GETTERS ***********************/

    public get eventMarchers() {
        return this._eventMarchers;
    }

    /** The collection of UI settings for the canvas. This must be synced with global state from the UiSettingsStore */
    public get uiSettings() {
        return this._uiSettings;
    }

    /** The FieldProperties this OpenMarchCanvas has been built on */
    public get fieldProperties() {
        return this._fieldProperties;
    }

    /**
     * Gets all objects of a specified type in the canvas.
     * Mostly used as a utility function, but can be called on its own.
     *
     * @param type The type of object to get (must be a subclass of fabric.Object)
     * @returns A list of objects of the specified type in the canvas
     */
    getObjectsByType<T extends fabric.Object>(
        type: new (...args: any[]) => T,
    ): T[] {
        return this.getObjects().filter((obj) => obj instanceof type) as T[];
    }

    /**
     * Gets all active (selected) objects of a specified type in the canvas.
     * Mostly used as a utility function, but can be called on its own.
     *
     * @param type The type of object to get (must be a subclass of fabric.Object)
     * @returns A list of active (selected) objects of the specified type in the canvas
     */
    getActiveObjectsByType<T extends fabric.Object>(
        type: new (...args: any[]) => T,
    ): T[] {
        return this.getActiveObjects().filter(
            (obj) => obj instanceof type,
        ) as T[];
    }

    /**
     * @param active true if you only want to return active (selected) objects. By default, false
     * @returns A list of all CanvasMarcher objects in the canvas
     */
    getCanvasMarchers({
        active = false,
    }: { active?: boolean } = {}): CanvasMarcher[] {
        return active
            ? this.getActiveObjectsByType(CanvasMarcher)
            : this.getObjectsByType(CanvasMarcher);
    }

    /**
     * Gets the CanvasMarcher objects with the given marcher ids
     *
     * @param marcherIds The ids of the marchers to get
     * @returns An array of CanvasMarcher objects with the given marcher ids
     */
    getCanvasMarchersByIds(marcherIds: number[]): CanvasMarcher[] {
        const marcherIdsSet = new Set(marcherIds);
        return this.getCanvasMarchers().filter((marcher) =>
            marcherIdsSet.has(marcher.marcherObj.id),
        );
    }

    /**
     * @param active true if you only want to return active (selected) objects. By default, false
     * @returns A list of all StaticCanvasMarcher objects in the canvas
     */
    getStaticCanvasMarchers({
        active = false,
    }: { active?: boolean } = {}): StaticCanvasMarcher[] {
        return active
            ? this.getActiveObjectsByType(StaticCanvasMarcher)
            : this.getObjectsByType(StaticCanvasMarcher);
    }

    /**
     * @param active true if you only want to return active (selected) objects. By default, false
     * @returns A list of all Pathway objects in the canvas
     */
    getPathways({ active = false }: { active?: boolean } = {}): Pathway[] {
        return active
            ? this.getActiveObjectsByType(Pathway)
            : this.getObjectsByType(Pathway);
    }

    /**
     * @returns A list of all selectable objects in the canvas
     */
    getAllSelectableObjects(): Selectable.ISelectable[] {
        return this.getObjects().filter(Selectable.isSelectable);
    }

    /**
     * @returns A list of all active (selected) selectable objects in the canvas
     */
    getActiveSelectableObjects(): Selectable.ISelectable[] {
        return this.getActiveObjects().filter(Selectable.isSelectable);
    }

    /*********************** SETTERS ***********************/
    /** Set the UI settings and make all of the changes in this canvas that correspond to it */
    setUiSettings(uiSettings: UiSettings) {
        const activeObject = this.getActiveObject();
        const oldUiSettings = this._uiSettings;
        this._uiSettings = uiSettings;
        if (activeObject) {
            activeObject.lockMovementX = uiSettings.lockX;
            activeObject.lockMovementY = uiSettings.lockY;
        }

        // Update trackpad settings if changed
        if (
            this.trackpadModeEnabled !== uiSettings.mouseSettings.trackpadMode
        ) {
            this.trackpadModeEnabled = uiSettings.mouseSettings.trackpadMode;
        }

        // Update sensitivity settings if they exist in the UI settings
        if (uiSettings.mouseSettings.panSensitivity) {
            this.panSensitivity = uiSettings.mouseSettings.panSensitivity;
        }
        if (uiSettings.mouseSettings.trackpadPanSensitivity) {
            this.trackpadPanSensitivity =
                uiSettings.mouseSettings.trackpadPanSensitivity;
        }
        if (uiSettings.mouseSettings.zoomSensitivity) {
            this.zoomSensitivity = uiSettings.mouseSettings.zoomSensitivity;
        }

        if (
            oldUiSettings.gridLines !== uiSettings.gridLines ||
            oldUiSettings.halfLines !== uiSettings.halfLines
        ) {
            this.renderFieldGrid();
        }

        // Update cursor based on canvas panning setting
        if (!uiSettings.mouseSettings.enableCanvasPanning) {
            this.defaultCursor = "default";
            this.moveCursor = "default";
        } else {
            this.defaultCursor = "grab";
            this.moveCursor = "grabbing";
        }
    }

    set eventMarchers(marchers: CanvasMarcher[]) {
        // remove the border from the previous event marchers
        this._eventMarchers.forEach((marcher) =>
            marcher.backgroundRectangle.set({
                strokeWidth: 0,
            }),
        );
        this._eventMarchers = marchers;
        // Change the marcher outline of the marchers in the event
        marchers.forEach((marcher) =>
            marcher.backgroundRectangle.set({
                strokeWidth: 2,
                stroke: rgbaToString(this.fieldProperties.theme.shape),
                strokeDashArray: [3, 5],
            }),
        );
        this.requestRenderAll();
    }

    set fieldProperties(fieldProperties: FieldProperties) {
        this._fieldProperties = fieldProperties;
        this.renderFieldGrid();
    }

    /**
     * Refreshes the background image of the canvas by fetching the field properties image from the Electron API.
     * If the image data is successfully retrieved, it is converted to a Fabric.js Image object and set as the background image.
     * If the image data is null, the background image is set to null.
     * Finally, the field grid is re-rendered to reflect the updated background image.
     */
    async refreshBackgroundImage(renderFieldGrid: boolean = true) {
        // if (this._backgroundImage) this.remove(this._backgroundImage);
        const backgroundImageResponse =
            await window.electron.getFieldPropertiesImage();

        if (this._backgroundImage) {
            this.remove(this._backgroundImage);
            this._backgroundImage = null;
        }
        if (backgroundImageResponse.success) {
            if (backgroundImageResponse.data === null) {
                this._backgroundImage = null;
                return;
            }

            const loadImage = async (): Promise<HTMLImageElement> => {
                return new Promise((resolve, reject) => {
                    const img = new Image();
                    img.onload = () => resolve(img);
                    img.onerror = reject;

                    const buffer = backgroundImageResponse.data as Buffer;
                    const blob = new Blob([buffer]);
                    img.src = URL.createObjectURL(blob);

                    return img;
                });
            };

            const img = await loadImage();

            FieldProperties.imageDimensions = {
                width: img.width,
                height: img.height,
            };

            this._backgroundImage = new fabric.Image(img, {
                height: img.height,
                width: img.width,
                left: 0,
                top: 0,
                selectable: false,
                hoverCursor: "default",
                evented: false,
            });

            const imgAspectRatio = img.width / img.height;
            this.refreshBackgroundImageValues(imgAspectRatio);
            renderFieldGrid && this.renderFieldGrid();
        } else {
            FieldProperties.imageDimensions = undefined;
            this._backgroundImage = null;
            console.error("Error fetching field properties image");
            console.error(backgroundImageResponse.error);
        }
    }

    /**
     * Refreshes all of the offset and scale values for the current background image.
     *
     * This does not fetch the most recent image from the database.
     */
    refreshBackgroundImageValues(newAspectRatio?: number) {
        // Do not refresh the values if the background image is not defined
        if (!this._backgroundImage) {
            return;
        }
        if (newAspectRatio === undefined && !this._bgImageValues)
            throw new Error(
                "Must provide an aspect ratio or have _bgImageValues be defined",
            );

        const imgAspectRatio =
            newAspectRatio ?? this._bgImageValues!.imgAspectRatio;
        const { width, height } = this.fieldProperties;
        const canvasAspectRatio = width / height;
        const offset = { left: 0, top: 0 };
        let scale: number;
        if (this.fieldProperties.imageFillOrFit === "fill") {
            if (imgAspectRatio > canvasAspectRatio) {
                scale = height / this._backgroundImage.height!;
                offset.left =
                    (width - this._backgroundImage.width! * scale) / 2;
            } else {
                scale = width / this._backgroundImage.width!;
                offset.top =
                    (height - this._backgroundImage.height! * scale) / 2;
            }
        } else {
            if (this.fieldProperties.imageFillOrFit !== "fit") {
                console.error(
                    "Invalid image fill or fit value. Defaulting to 'fit'",
                );
            }
            if (imgAspectRatio > canvasAspectRatio) {
                scale = width / this._backgroundImage.width!;
                offset.top =
                    (height - this._backgroundImage.height! * scale) / 2;
            } else {
                scale = height / this._backgroundImage.height!;
                offset.left =
                    (width - this._backgroundImage.width! * scale) / 2;
            }
        }
        this._bgImageValues = {
            ...offset,
            scale,
            imgAspectRatio: imgAspectRatio,
        };
    }

    /*********************** SELECTION UTILITIES ***********************/
    /**
     * Set the given Selectable objects as active  (selected) objects on the canvas
     *
     * @param newSelectedObjects The new selected CanvasMarchers
     */
    setActiveObjects = (newSelectedObjects: Selectable.ISelectable[]) => {
        if (this.handleSelectLock) return;
        this.handleSelectLock = true;

        if (newSelectedObjects.length === 1) {
            this.setActiveObject(newSelectedObjects[0]);
        } else if (newSelectedObjects.length > 1) {
            // The current active object needs to be discarded before creating a new active selection
            // This is due to buggy behavior in Fabric.js
            this.discardActiveObject();

            const activeSelection = new fabric.ActiveSelection(
                newSelectedObjects,
                {
                    canvas: this,
                    ...ActiveObjectArgs,
                },
            );

            this.setActiveObject(activeSelection);
        } else {
            this.discardActiveObject();
        }

        this.requestRenderAll();
        // is this safe? Could there be a point when this is set to false before the handler has a chance to run?
        this.handleSelectLock = false;
    };

    /**
     * Checks if the given fabric event has Selectable objects (either a single one or a group)
     *
     * @param fabricEvent The fabric event to check if selectable objects are selected
     * @returns boolean
     */
    static selectionHasObjects = (fabricEvent: fabric.IEvent<MouseEvent>) => {
        // fabricEvent.target checks if the mouse is on the canvas at all
        return (
            fabricEvent.target &&
            (fabricEvent.target.selectable ||
                // If the target is a group of selectable objects (currently only checked if any of the objects are selectable)
                // TODO - this is accessing a private property of fabric.Object. This is not ideal
                ((fabricEvent.target as any)._objects !== undefined &&
                    (fabricEvent.target as any)._objects.some(
                        (obj: any) => obj.selectable,
                    )))
        );
    };

    /**
     * Detects if running on MacOS
     */
    private isMacOS(): boolean {
        return navigator.platform.indexOf("Mac") > -1;
    }

    /**
     * A backup method to manually pan the canvas
     */
    private manualPan(deltaX: number, deltaY: number): void {
        this.panContainer(deltaX, deltaY);
    }

    /**
     * Set trackpad mode from settings
     * @param enabled Whether trackpad mode should be enabled
     */
    public setTrackpadMode(enabled: boolean) {
        this.trackpadModeEnabled = enabled;
    }

    /**
     * Get current trackpad mode state
     * @returns Current trackpad mode state (enabled/disabled)
     */
    public getTrackpadMode(): boolean {
        return this.trackpadModeEnabled;
    }

    /**
     * Set pan sensitivity value from settings
     * @param value New pan sensitivity value
     */
    public setPanSensitivity(value: number) {
        this.panSensitivity = Math.max(0.1, Math.min(3.0, value));
    }

    /**
     * Set trackpad pan sensitivity value from settings
     * @param value New trackpad pan sensitivity value
     */
    public setTrackpadPanSensitivity(value: number) {
        this.trackpadPanSensitivity = Math.max(0.1, Math.min(3.0, value));
    }

    /**
     * Set zoom sensitivity value from settings
     * @param value New zoom sensitivity value
     */
    public setZoomSensitivity(value: number) {
        this.zoomSensitivity = Math.max(0.01, Math.min(0.5, value));
    }

    /**
     * Get current pan sensitivity value
     * @returns Current pan sensitivity
     */
    public getPanSensitivity(): number {
        return this.panSensitivity;
    }

    /**
     * Get current trackpad pan sensitivity value
     * @returns Current trackpad pan sensitivity
     */
    public getTrackpadPanSensitivity(): number {
        return this.trackpadPanSensitivity;
    }

    /**
     * Get current zoom sensitivity value
     * @returns Current zoom sensitivity
     */
    public getZoomSensitivity(): number {
        return this.zoomSensitivity;
    }

    /**
     * Exports the canvas as SVG
     * @param options Optional SVG export options
     * @returns SVG string representation of the canvas
     */
    toSVG = (options?: any): string => {
        try {
            // Store current viewport transform to restore later
            const originalVPT = this.viewportTransform;

            // Reset viewport to show entire field (no zoom/pan)
            this.setViewportTransform([1, 0, 0, 1, 0, 0]);

            // Get the field dimensions
            const fieldWidth = this.fieldProperties.width;
            const fieldHeight = this.fieldProperties.height;

            // Store original canvas dimensions
            const originalWidth = this.width;
            const originalHeight = this.height;

            // Temporarily set canvas size to match field dimensions for export
            this.setWidth(fieldWidth);
            this.setHeight(fieldHeight);

            // Force a render to ensure everything is up to date
            this.requestRenderAll();

            // Call the parent toSVG method with proper options
            const svgOptions = {
                width: fieldWidth,
                height: fieldHeight,
                viewBox: {
                    x: 0,
                    y: 0,
                    width: fieldWidth,
                    height: fieldHeight,
                },
                ...options,
            };

            const svgString = super.toSVG(svgOptions);

            // Restore original viewport transform
            if (originalVPT) {
                this.setViewportTransform(originalVPT);
            }

            // Restore original canvas dimensions
            this.setWidth(originalWidth || fieldWidth);
            this.setHeight(originalHeight || fieldHeight);

            // Force another render to restore the view
            this.requestRenderAll();

            return svgString;
        } catch (error) {
            console.error("Error exporting canvas to SVG:", error);
            throw new Error(
                `Failed to export canvas to SVG: ${error instanceof Error ? error.message : "Unknown error"}`,
            );
        }
    };
}
