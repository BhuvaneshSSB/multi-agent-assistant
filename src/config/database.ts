import {Pool} from "pg";
import {config} from "./env";

let pool: Pool | null=null;

export function initializeDatabase(): Pool {
    if (!pool) {
        pool = new Pool({
            connectionString:config.database.url,
            max:20,
            idleTimeoutMillis:30000,
            connectionTimeoutMillis:2000,
        });

        pool.on("error",(err) => {
            console.error("Unexpected error on idle client",err);
        });
    }
    return pool;
}

export function getDatabase(): Pool {
    if (!pool) {
        throw new Error("Database not initialized. Call initializeDatabase() first.");
    }
    return pool;
}

export async function testDatabaseConnection(): Promise<boolean> {
    try{
        const db = getDatabase();
        const result = await db.query("SELECT NOW()");
        console.log("Database connection successful:", result.rows[0]);
        return true;
    } catch(error) {
        console.error("Database connection failed:", error);
        return false;
    }
}