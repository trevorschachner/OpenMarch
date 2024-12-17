import { dialog, BrowserWindow, app } from "electron";
import * as path from "path";
import * as fs from "fs";
import sanitize from "sanitize-filename";

interface ExportSheet {
    name: string;
    section: string;
    renderedPage: string;
}

export class PDFExportService {
    private static async generateSinglePDF(pages: string[]) {
        return new Promise<Buffer>((resolve, reject) => {
            const win = new BrowserWindow({
                width: 1200,
                height: 800,
                show: false,
                webPreferences: {
                    nodeIntegration: true,
                    contextIsolation: false,
                },
            });

            // Group pages into sets of four
            const groupedPages = [];
            for (let i = 0; i < pages.length; i += 4) {
                groupedPages.push(pages.slice(i, i + 4));
            }

            // Create HTML for each group of four pages
            const combinedHtml = groupedPages
                .map(
                    (group, index) => `
          <div class="grid-container">
            ${group
                .map(
                    (pageContent) => `
                <div class="grid-item">
                  <div class="page-content">${pageContent}</div>
                </div>
              `,
                )
                .join("")}
          </div>
          ${index < groupedPages.length - 1 ? '<div style="page-break-after: always;"></div>' : ""}
        `,
                )
                .join("");

            const htmlContent = `
        <html>
          <head>
            <style>
              @media print {
                body { margin: 0; }
                .grid-container {
                  display: grid;
                  grid-template-columns: 1fr 1fr;
                  grid-template-rows: 1fr 1fr;
                  gap: 20px;
                  width: 100%;
                  height: 100%;
                  box-sizing: border-box;
                  padding: 20px;
                  break-inside: avoid;
                }
                .grid-item {
                  width: 100%;
                  height: 100%;
                  overflow: hidden;
                  box-sizing: border-box;
                  border: 1px solid #000;
                  padding: 10px;
                }
                .page-content {
                  transform: scale(0.5);
                  transform-origin: top left;
                  width: 200%;
                  height: 200%;
                }
              }
            </style>
          </head>
          <body>${combinedHtml}</body>
        </html>
      `;

            win.loadURL(
                `data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`,
            );

            win.webContents.on("did-finish-load", () => {
                win.webContents
                    .printToPDF({
                        margins: {
                            marginType: "custom",
                            top: 0,
                            bottom: 0,
                            left: 0,
                            right: 0,
                        },
                        pageSize: "Letter",
                        printBackground: true,
                    })
                    .then((data) => {
                        win.close();
                        resolve(data);
                    })
                    .catch((error) => {
                        win.close();
                        reject(error);
                    });
            });
        });
    }

    private static async generateSeparatePDFs(
        sheets: ExportSheet[],
        outputPath: string,
    ) {
        const sectionMap = new Map<string, ExportSheet[]>();

        sheets.forEach((sheet) => {
            const section = sheet.section || "Other";
            if (!sectionMap.has(section)) {
                sectionMap.set(section, []);
            }
            sectionMap.get(section)!.push(sheet);
        });

        for (const [section, sectionSheets] of sectionMap) {
            const sectionDir = path.join(outputPath, sanitize(section));
            await fs.promises.mkdir(sectionDir, { recursive: true });

            for (const sheet of sectionSheets) {
                await new Promise<void>((resolve) => {
                    const win = new BrowserWindow({
                        width: 1200,
                        height: 800,
                        show: false,
                        webPreferences: {
                            nodeIntegration: true,
                            contextIsolation: false,
                        },
                    });

                    win.loadURL(
                        `data:text/html;charset=utf-8,${encodeURIComponent(sheet.renderedPage)}`,
                    );

                    win.webContents.on("did-finish-load", () => {
                        const filePath = path.join(
                            sectionDir,
                            `${sanitize(sheet.name)}.pdf`,
                        );

                        win.webContents
                            .printToPDF({
                                margins: {
                                    marginType: "custom",
                                    top: 0,
                                    bottom: 0,
                                    left: 0,
                                    right: 0,
                                },
                                pageSize: "Letter",
                                printBackground: true,
                            })
                            .then(async (data) => {
                                const blob = new Blob([data], {
                                    type: "application/pdf",
                                });
                                const arrayBuffer = await blob.arrayBuffer();
                                await fs.promises.writeFile(
                                    filePath,
                                    new Uint8Array(arrayBuffer),
                                );
                                win.close();
                                resolve();
                            });
                    });
                });
            }
        }
    }

    public static async export(
        sheets: ExportSheet[],
        organizeBySection: boolean,
    ) {
        try {
            if (organizeBySection) {
                const result = await dialog.showSaveDialog({
                    title: "Select Export Location",
                    defaultPath: this.getDefaultPath(),
                    properties: [
                        "createDirectory",
                        "showOverwriteConfirmation",
                    ],
                    buttonLabel: "Export Here",
                });

                if (result.canceled || !result.filePath) {
                    throw new Error("Export cancelled");
                }
                await this.generateSeparatePDFs(sheets, result.filePath);
            } else {
                const pdfBuffer = await this.generateSinglePDF(
                    sheets.map((s) => s.renderedPage),
                );

                const result = await dialog.showSaveDialog({
                    title: "Save PDF",
                    defaultPath: `${this.getDefaultPath()}.pdf`,
                    filters: [{ name: "PDF", extensions: ["pdf"] }],
                    properties: ["showOverwriteConfirmation"],
                });

                if (!result.canceled && result.filePath) {
                    await fs.promises.writeFile(result.filePath, pdfBuffer);
                }
            }
            return { success: true };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    private static getDefaultPath(): string {
        const date = new Date().toISOString().split("T")[0];
        const win = BrowserWindow.getFocusedWindow();
        const currentFileName = win
            ? win.getTitle().replace(/\.[^/.]+$/, "")
            : "untitled";
        return path.join(
            app.getPath("documents"),
            `${currentFileName}-${date}-coordinate-sheets`,
        );
    }
}