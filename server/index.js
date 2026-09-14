import "dotenv/config";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { TerminalService } from "./terminal-service.js";

const config = readConfig();
const terminalService = new TerminalService(config);
const app = createApp({ terminalService, config });

app.listen(config.port, () => {
  console.log(`Smile Printer is ready at http://localhost:${config.port}`);
});
