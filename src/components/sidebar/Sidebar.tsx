import MarcherEditor from "./MarcherEditor";
import PageEditor from "./PageEditor";
import AlignmentEditor from "./AlignmentEditor";
import ShapeEditor from "./ShapeEditor";

function Sidebar() {
    return (
        <div className="flex w-[20rem] min-w-0 flex-col gap-48 overflow-y-scroll rounded-6 border border-stroke bg-fg-1 p-12">
            <PageEditor />
            <MarcherEditor />
            <ShapeEditor />
            <AlignmentEditor />
        </div>
    );
}

export default Sidebar;
