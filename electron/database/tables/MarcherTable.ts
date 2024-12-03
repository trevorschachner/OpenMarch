import Constants from "../../../src/global/Constants";
import * as History from "../database.history";
import Database from "better-sqlite3";
import * as DbActions from "../DatabaseActions";
import {
    ModifiedMarcherArgs,
    NewMarcherArgs,
    DatabaseMarcher,
} from "../../../src/global/classes/Marcher";
import * as PageTable from "./PageTable";
import * as MarcherPageTable from "./MarcherPageTable";
import { DatabaseResponse } from "../DatabaseActions";
import { ModifiedMarcherPageArgs } from "@/global/classes/MarcherPage";

export function createMarcherTable(
    db: Database.Database,
): DatabaseResponse<string> {
    try {
        db.exec(`
            CREATE TABLE IF NOT EXISTS "${Constants.MarcherTableName}" (
                "id"	        INTEGER PRIMARY KEY,
                "name"	        TEXT,
                "section"	    TEXT NOT NULL,
                "year"	        TEXT,
                "notes"	        TEXT,
                "drill_prefix"	TEXT NOT NULL,
                "drill_order"	INTEGER NOT NULL,
                "created_at"	TEXT NOT NULL,
                "updated_at"	TEXT NOT NULL,
                UNIQUE ("drill_prefix", "drill_order")
            );
        `);
        History.createUndoTriggers(db, Constants.MarcherTableName);
        console.log("Marcher table created.");
        return { success: true, data: Constants.MarcherTableName };
    } catch (error: any) {
        throw new Error(`Failed to create marcher table: ${error}`);
    }
}

/**
 * @param db The database connection, or undefined to create a new connection
 * @returns An array of all marchers in the database
 */
export function getMarchers({
    db,
}: {
    db: Database.Database;
}): DatabaseResponse<DatabaseMarcher[]> {
    const response = DbActions.getAllItems<DatabaseMarcher>({
        db,
        tableName: Constants.MarcherTableName,
    });
    return response;
}

/**
 * Updates a list of marchers with the given values.
 *
 * @param newMarcherArgs
 * @returns - {success: boolean, error?: string}
 */
export function createMarchers({
    newMarchers,
    db,
}: {
    newMarchers: NewMarcherArgs[];
    db: Database.Database;
}): DatabaseResponse<DatabaseMarcher[]> {
    console.log("\n=========== start createPages ===========");
    History.incrementUndoGroup(db);
    let output: DatabaseResponse<DatabaseMarcher[]>;
    let actionWasPerformed = false;

    try {
        const marcherInsertResponse = DbActions.createItems<
            DatabaseMarcher,
            NewMarcherArgs
        >({
            items: newMarchers,
            tableName: Constants.MarcherTableName,
            db,
            printHeaders: false,
            useNextUndoGroup: false,
        });
        if (!marcherInsertResponse.success) {
            throw new Error(
                marcherInsertResponse.error?.message ||
                    "Failed to create marchers",
            );
        }

        // Create a marcherPage for each marcher and page
        const allPages = PageTable.getPages({ db });
        if (!allPages.success) {
            throw new Error(
                allPages.error?.message || "Failed to get all pages",
            );
        }
        // Create a marcherPage for each marcher
        const newMarcherPages: ModifiedMarcherPageArgs[] = [];
        for (const marcher of marcherInsertResponse.data) {
            for (const page of allPages.data) {
                newMarcherPages.push({
                    marcher_id: marcher.id,
                    page_id: page.id,
                    x: 100,
                    y: 100,
                });
            }
        }
        const createMarcherPageResponse = MarcherPageTable.createMarcherPages({
            newMarcherPages,
            db,
            useNextUndoGroup: false,
        });
        if (!createMarcherPageResponse.success) {
            throw new Error(
                createMarcherPageResponse.error?.message ||
                    "Failed to create marcherPage",
            );
        }
        History.incrementUndoGroup(db);
        return marcherInsertResponse;
    } catch (error: any) {
        console.error("Failed to create marchers:", error);
        if (actionWasPerformed) {
            History.performUndo(db);
            History.clearMostRecentRedo(db);
        }
        output = {
            success: false,
            error: { message: error.message, stack: error.stack },
            data: [],
        };
    } finally {
        console.log("=========== end createPages ===========\n");
    }
    return output;
}

/**
 * Update a list of marchers with the given values.
 *
 * @param modifiedMarchers Array of ModifiedMarcherArgs that contain the id of the
 *                    marcher to update and the values to update it with
 * @returns - {success: boolean, error: string}
 */
export function updateMarchers({
    modifiedMarchers,
    db,
}: {
    modifiedMarchers: ModifiedMarcherArgs[];
    db: Database.Database;
}): DatabaseResponse<DatabaseMarcher[]> {
    console.log("\n=========== start updatePages ===========");
    const updateResponse = DbActions.updateItems<
        DatabaseMarcher,
        ModifiedMarcherArgs
    >({
        db,
        items: modifiedMarchers,
        tableName: Constants.MarcherTableName,
        printHeaders: false,
    });
    console.log("=========== end updatePages ===========\n");
    return updateResponse;
}

/**
 * Deletes the marcher with the given id and all of their marcherPages.
 * CAUTION - This will also delete all of the marcherPages associated with the marcher.
 *
 * @param marcherIds
 * @returns {success: boolean, error?: string}
 */
export function deleteMarchers({
    marcherIds,
    db,
}: {
    marcherIds: Set<number>;
    db: Database.Database;
}): DbActions.DatabaseResponse<DatabaseMarcher[]> {
    History.incrementUndoGroup(db);
    const marcherDeleteResponse = DbActions.deleteItems<DatabaseMarcher>({
        ids: marcherIds,
        tableName: Constants.MarcherTableName,
        db,
        useNextUndoGroup: false,
    });

    if (!marcherDeleteResponse.success) {
        console.error(
            "Failed to delete marchers:",
            marcherDeleteResponse.error,
        );
        return marcherDeleteResponse;
    }

    return marcherDeleteResponse;
}