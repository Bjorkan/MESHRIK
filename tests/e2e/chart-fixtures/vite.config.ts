import path from "node:path";
import { fileURLToPath } from "node:url";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(fixtureDir, "../../../frontend");

export default {
  resolve: {
    alias: {
      react: path.join(frontendDir, "node_modules/react"),
      "react-dom": path.join(frontendDir, "node_modules/react-dom"),
    },
  },
  server: {
    fs: { allow: [fixtureDir, frontendDir] },
  },
};
