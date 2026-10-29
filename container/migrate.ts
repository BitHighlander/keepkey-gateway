import { loadConfig } from "./src/config";
import { createDatabase } from "./src/database";

const database = createDatabase(loadConfig());
try {
	await database.migrate();
	await database.ping();
	console.log("Gateway migrations complete; database connectivity verified.");
} finally {
	await database.close();
}
