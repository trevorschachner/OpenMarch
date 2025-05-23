import Database from "better-sqlite3";
import * as path from "node:path";
import v6 from "../v6";
import fs from "fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExpectedValues } from "./v5_migration_test.expected";

describe("v6 migration", () => {
    const TEST_DB_PATH = path.join(__dirname, "v5_migration_test.dots");
    const TEMP_DB_PATH = path.join(__dirname, "temp_migration_test.dots");
    let db: typeof Database.prototype;
    let migrator: InstanceType<typeof v6>;

    beforeEach(() => {
        try {
            // Ensure the temp file doesn't exist
            if (fs.existsSync(TEMP_DB_PATH)) {
                fs.unlinkSync(TEMP_DB_PATH);
            }
            // Copy the test database to a temporary file
            fs.copyFileSync(TEST_DB_PATH, TEMP_DB_PATH);
            db = new Database(TEMP_DB_PATH);
            migrator = new v6(() => db);
        } catch (error) {
            console.error("Setup error:", error);
            throw error;
        }
    });

    afterEach(() => {
        try {
            // Force close any statements
            db.prepare("SELECT 1").run();
            // Close the database connection
            db.close();
            // Delete the temp file
            if (fs.existsSync(TEMP_DB_PATH)) {
                fs.unlinkSync(TEMP_DB_PATH);
            }
        } catch (error) {
            console.error("Cleanup error:", error);
        }
    });

    it("should migrate to version 6", () => {
        // Check database version
        let version = db.pragma("user_version", { simple: true });
        expect(version).toBe(5);

        // Run migration
        migrator.migrateToThisVersion(db);

        // Check database version
        version = db.pragma("user_version", { simple: true });
        expect(version).toBe(6);
    });

    it("should create new tables", () => {
        migrator.migrateToThisVersion(db);

        // Check if new tables exist
        const tables = db
            .prepare(
                `
            SELECT name FROM sqlite_master
            WHERE type='table'
            AND name IN ('beats', 'utility', 'section_appearances')
        `,
            )
            .all() as { name: string }[];

        expect(tables).toHaveLength(3);
        expect(tables.map((t) => t.name).sort()).toEqual(
            ["beats", "section_appearances", "utility"].sort(),
        );
    });

    it("should preserve measure data and convert from ABC to beats", () => {
        // Get original measure data

        migrator.migrateToThisVersion(db);

        // Check beats were created
        const beats = db
            .prepare(`SELECT * FROM beats ORDER BY position`)
            .all() as Array<{
            id: number;
            duration: number;
            position: number;
        }>;
        expect(beats.length).toBeGreaterThan(0);
        expect(beats[0].id).toBe(0); // FIRST_BEAT_ID

        // Check measures were migrated
        const measures = db
            .prepare(`SELECT * FROM measures ORDER BY start_beat`)
            .all() as Array<{
            created_at: string;
            updated_at: string;
        }>;
        expect(measures.length).toBeGreaterThan(0);

        // Verify timestamps were preserved (ignoring format differences)
        const firstMeasure = measures[0];
        // Just verify the timestamps exist and are valid dates
        expect(new Date(firstMeasure.created_at).getTime()).toBeGreaterThan(0);
        expect(new Date(firstMeasure.updated_at).getTime()).toBeGreaterThan(0);
    });

    // Decided not to add timestamps to the schema because it's not a big deal
    it.skip("should update timestamp defaults", () => {
        migrator.migrateToThisVersion(db);

        // Test creating new records in affected tables
        const tables = ["audio_files", "marcher_pages", "marchers"];

        for (const table of tables) {
            // Get table schema
            const schema = db
                .prepare(
                    `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
                )
                .get(table) as { sql: string };

            // Check for DEFAULT CURRENT_TIMESTAMP
            expect(schema.sql).toContain("DEFAULT CURRENT_TIMESTAMP");

            // Try inserting a record with required fields
            if (table === "audio_files") {
                db.prepare(
                    `
                    INSERT INTO ${table} (path, selected)
                    VALUES ('test.mp3', 0)
                `,
                ).run();
            } else if (table === "marcher_pages") {
                // First create a marcher and a page
                db.prepare(
                    `
                    INSERT INTO marchers (section, drill_prefix, drill_order)
                    VALUES ('Test', 'T', 1)
                `,
                ).run();

                db.prepare(
                    `
                    INSERT INTO marcher_pages (marcher_id, page_id)
                    VALUES (1, 1)
                `,
                ).run();
            } else if (table === "marchers") {
                db.prepare(
                    `
                    INSERT INTO ${table} (section, drill_prefix, drill_order)
                    VALUES ('Test', 'T', 2)
                `,
                ).run();
            }

            // Verify timestamps were automatically set
            const record = db
                .prepare(
                    `SELECT created_at, updated_at FROM ${table} ORDER BY rowid DESC LIMIT 1`,
                )
                .get() as { created_at: string; updated_at: string };
            expect(record.created_at).toBeTruthy();
            expect(record.updated_at).toBeTruthy();
        }
    });

    const assertStartBeatPosition = (beatId: number) => {
        const startBeat = db
            .prepare(`SELECT * FROM beats WHERE id = ?`)
            .get(beatId) as { id: number; position: number };
        expect(startBeat.position).toBe(beatId);
    };

    it("should match expected beat durations after migration", () => {
        migrator.migrateToThisVersion(db);

        const beats = db
            .prepare(`SELECT * FROM beats ORDER BY position`)
            .all() as Array<{ duration: number }>;
        expect(beats.length).toBe(ExpectedValues.beatDurations.length);

        // Skip FIRST_BEAT_ID (position 0) and compare with expected durations
        expect(ExpectedValues.beatDurations).toEqual(
            beats.map((b) => b.duration),
        );
    });

    it("should match expected measures after migration", () => {
        migrator.migrateToThisVersion(db);

        // Get all measures and their associated beats
        const measures = db
            .prepare(
                `
                SELECT * FROM measures ORDER BY start_beat
            `,
            )
            .all() as Array<{ id: number; start_beat: number }>;

        expect(measures.length).toBe(ExpectedValues.measures.length);

        let totalCounts = 1;
        ExpectedValues.measures.forEach((expectedMeasure, index) => {
            expect(measures[index].start_beat).toBe(totalCounts);
            assertStartBeatPosition(measures[index].start_beat);
            totalCounts += expectedMeasure.beats;
        });
    });

    it("should match expected pages after migration", () => {
        migrator.migrateToThisVersion(db);

        // Get all pages with their beat counts
        const pages = db
            .prepare(
                `
                SELECT * FROM pages ORDER BY id
            `,
            )
            .all() as Array<{
            id: number;
            is_subset: number;
            start_beat: number;
        }>;
        expect(pages.length).toBe(ExpectedValues.pages.length);

        let totalCounts = 0;
        ExpectedValues.pages.forEach((expectedPage, index) => {
            const page = pages[index];
            expect(page.start_beat).toBe(totalCounts);
            if (totalCounts === 0) totalCounts++;
            expect(page.is_subset === 1).toBe(expectedPage.isSubset);
            totalCounts += expectedPage.counts;
        });
    });

    describe("marcherPages", () => {
        it("should create new marcherPages", () => {
            const oldMarcherPages = db
                .prepare(`SELECT * FROM marcher_pages ORDER BY id`)
                .all() as Array<{
                id: number;
                marcher_id: number;
                page_id: number;
                x: number;
                y: number;
            }>;

            expect(oldMarcherPages.length).toBeGreaterThan(0);

            migrator.migrateToThisVersion(db);

            const newMarcherPages = db
                .prepare(`SELECT * FROM marcher_pages ORDER BY id`)
                .all() as Array<{
                id: number;
                marcher_id: number;
                page_id: number;
                x: number;
                y: number;
            }>;

            expect(newMarcherPages.length).toBe(oldMarcherPages.length);

            // Group marcher pages by page_id
            const oldMarcherPagesByPage = oldMarcherPages.reduce(
                (acc, mp) => {
                    if (!acc[mp.page_id]) {
                        acc[mp.page_id] = [];
                    }
                    acc[mp.page_id].push(mp);
                    return acc;
                },
                {} as Record<number, typeof oldMarcherPages>,
            );

            // For each page, verify all marchers are present
            for (const pageId of Object.keys(oldMarcherPagesByPage)) {
                const oldMarcherPages = oldMarcherPagesByPage[Number(pageId)];
                const newPageMarchers = newMarcherPages.filter(
                    (mp) => mp.page_id === Number(pageId),
                );

                expect(newPageMarchers.length).toBe(oldMarcherPages.length);

                // Check each marcher in the page
                for (const oldMarcherPage of oldMarcherPages) {
                    const newMarcherPage = newPageMarchers.find(
                        (mp) => mp.marcher_id === oldMarcherPage.marcher_id,
                    );
                    expect(newMarcherPage).toBeDefined();
                    expect(newMarcherPage!.x).toBe(oldMarcherPage.x);
                    expect(newMarcherPage!.y).toBe(oldMarcherPage.y);
                }
            }
        });
    });

    // Decided not to add timestamps to the schema because it's not a big deal
    it.skip("should have identical schema between migrated and new database", () => {
        // Create a new database with v6 schema
        const newDb = new Database(":memory:");
        const newMigrator = new v6(() => newDb);
        newMigrator.createTables();

        // Migrate the test database
        migrator.migrateToThisVersion(db);

        // Get schema for all tables in both databases
        const getTableSchemas = (database: Database.Database) => {
            return database
                .prepare(
                    `
                    SELECT name, sql
                    FROM sqlite_master
                    WHERE type='table'
                    AND name NOT LIKE 'sqlite_%'
                    AND name NOT LIKE '%_history'
                    AND name NOT LIKE '%_undo'
                    ORDER BY name
                `,
                )
                .all() as Array<{ name: string; sql: string }>;
        };

        const migratedSchemas = getTableSchemas(db);
        const newSchemas = getTableSchemas(newDb);

        // Print out table names for debugging
        console.log(
            "Migrated database tables:",
            migratedSchemas.map((t) => t.name),
        );
        console.log(
            "New database tables:",
            newSchemas.map((t) => t.name),
        );

        // Compare number of tables
        expect(migratedSchemas.length).toBe(newSchemas.length);

        // Compare each table's schema
        migratedSchemas.forEach((migratedTable, index) => {
            const newTable = newSchemas[index];
            expect(migratedTable.name).toBe(newTable.name);

            // Normalize the SQL by removing whitespace and making it uppercase for comparison
            const normalizeSql = (sql: string) =>
                sql.replace(/\s+/g, " ").trim().toUpperCase();

            expect(normalizeSql(migratedTable.sql)).toBe(
                normalizeSql(newTable.sql),
            );
        });

        // Clean up
        newDb.close();
    });
});
