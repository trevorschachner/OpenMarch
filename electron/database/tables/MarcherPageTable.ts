import MarcherPage, {
    ModifiedMarcherPageArgs,
} from "../../../src/global/classes/MarcherPage";
import Constants from "../../../src/global/Constants";
import Database from "better-sqlite3";
import * as DbActions from "../DatabaseActions";
import { DatabaseResponse } from "../DatabaseActions";
import { getSpmByMarcherPage } from "./ShapePageMarcherTable";

/**
 * Gets all of the marcherPages, or the marcherPages with the given marcher_id and/or page_id.
 *
 * @param args { marcher_id?: number, page_id?: number}
 * @returns Array of marcherPages
 */
export function getMarcherPages(args: {
    db: Database.Database;
    marcher_id?: number;
    page_id?: number;
}): DatabaseResponse<MarcherPage[]> {
    let stmt = args.db.prepare(
        `SELECT * FROM ${Constants.MarcherPageTableName}`,
    );
    if (args) {
        if (args.marcher_id && args.page_id)
            stmt = args.db.prepare(
                `SELECT * FROM ${Constants.MarcherPageTableName} WHERE marcher_id = ${args.marcher_id} AND page_id = ${args.page_id}`,
            );
        else if (args.marcher_id)
            stmt = args.db.prepare(
                `SELECT * FROM ${Constants.MarcherPageTableName} WHERE marcher_id = ${args.marcher_id}`,
            );
        else if (args.page_id)
            stmt = args.db.prepare(
                `SELECT * FROM ${Constants.MarcherPageTableName} WHERE page_id = ${args.page_id}`,
            );
    }
    const result = stmt.all() as MarcherPage[];
    return { success: true, data: result };
}

/**
 * Gets the marcherPage with the given marcher_id and page_id.
 * TODO: NOT TESTED
 *
 * @param args { marcher_id: number, page_id: number}
 * @returns The marcherPage
 */
export function getMarcherPage(args: {
    db: Database.Database;
    marcher_id: number;
    page_id: number;
}): DatabaseResponse<MarcherPage | null> {
    const response = getMarcherPages(args);
    return {
        success: response.success,
        data: response.data[0] || null,
        error: response.error,
    };
}

/**
 * Adds new marcherPages to the database.
 * NOTE - this function should only be called from createMarcher and createPage.
 * A marcherPage should not be created manually by the user.
 *
 * @param db The database connection
 * @param newMarcherPages The marcherPages to add
 * @param useNextUndoGroup Whether or not to use the next undo group
 * @returns
 */
export function createMarcherPages({
    db,
    newMarcherPages,
    useNextUndoGroup,
}: {
    db: Database.Database;
    newMarcherPages: ModifiedMarcherPageArgs[];
    useNextUndoGroup: boolean;
}): DatabaseResponse<MarcherPage | null> {
    const response = DbActions.createItems<
        MarcherPage,
        ModifiedMarcherPageArgs
    >({
        db,
        items: newMarcherPages,
        tableName: Constants.MarcherPageTableName,
        useNextUndoGroup,
        printHeaders: false,
    });

    return {
        success: response.success,
        data: response.data[0] || null,
        error: response.error,
    };
}

interface NewModifiedMarcherPageArgs extends ModifiedMarcherPageArgs {
    id: number;
}

/**
 * Checks if a given MarcherPage is locked, by checking if there is a record in the ShapePageMarcher table for the
 * provided marcher_id and page_id.
 *
 * @param db - The database connection.
 * @param marcherId - The ID of the Marcher.
 * @param pageId - The ID of the Page.
 * @returns - `true` if the MarcherPage is locked, `false` otherwise.
 * @throws - An error if there was a failure to check the lock status.
 */
const isLocked = ({
    db,
    marcherId,
    pageId,
}: {
    db: Database.Database;
    marcherId: number;
    pageId: number;
}): boolean => {
    let output = false;
    try {
        // Check the ShapePageMarcher table to see if there is a record for this marcher_id and page_id
        const response = getSpmByMarcherPage({
            db,
            marcherPage: { marcher_id: marcherId, page_id: pageId },
        });
        if (!response.success)
            throw new Error(response.error?.message || "Failed to get SPM");
        output = response.data !== null;
    } catch (error) {
        throw new Error(`Failed to check if MarcherPage is locked: ${error}\n`);
    }
    return output;
};

/**
 * Updates a list of marcherPages with the given values.
 *
 * @param marcherPageUpdates: Array of UpdateMarcherPage objects that contain the marcher_id and page_id of the
 *                  marcherPage to update and the values to update it with
 * @param isChildAction Whether or not this is a child action of another action.
 *                      If true, it will not check for shape dependencies or increment the undo group.
 * @returns - {success: boolean, result: Database.result | string}
 */
export function updateMarcherPages({
    db,
    marcherPageUpdates,
    isChildAction = false,
}: {
    db: Database.Database;
    marcherPageUpdates: ModifiedMarcherPageArgs[];
    isChildAction?: boolean;
}): DatabaseResponse<MarcherPage[]> {
    const newUpdatedItems: NewModifiedMarcherPageArgs[] = [];
    for (const update of marcherPageUpdates) {
        const id = (
            db
                .prepare(
                    `SELECT id FROM ${Constants.MarcherPageTableName}
                        WHERE "marcher_id" = (@marcher_id) AND "page_id" = (@page_id)`,
                )
                .get({
                    marcher_id: update.marcher_id,
                    page_id: update.page_id,
                }) as { id: number }
        ).id;

        // Do not check if this is locked if this is a child action
        let mpIsLocked = false;
        if (!isChildAction) {
            mpIsLocked = isLocked({
                db,
                marcherId: update.marcher_id,
                pageId: update.page_id,
            });
        }

        if (!mpIsLocked)
            newUpdatedItems.push({
                ...update,
                id,
            });
    }

    const response = DbActions.updateItems<
        MarcherPage,
        NewModifiedMarcherPageArgs
    >({
        db,
        items: newUpdatedItems,
        tableName: Constants.MarcherPageTableName,
        useNextUndoGroup: !isChildAction,
        printHeaders: !isChildAction,
    });

    return response;
}
