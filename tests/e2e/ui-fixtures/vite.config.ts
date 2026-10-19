import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(root, "../../../frontend");

export default {
  root,
  resolve: {
    alias: {
      "@": path.join(frontend, "src"),
      "@tanstack/react-query": path.join(
        frontend,
        "node_modules/@tanstack/react-query",
      ),
      react: path.join(frontend, "node_modules/react"),
      "react-dom": path.join(frontend, "node_modules/react-dom"),
    },
  },
  esbuild: { jsx: "automatic" },
  css: { postcss: frontend },
  server: { fs: { allow: [root, frontend] } },
};
