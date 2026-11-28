import { actAs } from "./support/credentials.js";

export const headers = { "x-sfly-client": "sfly-cli/1.0.0", ...actAs("bob") };
