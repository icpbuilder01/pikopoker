import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { icpBindgen } from "@icp-sdk/bindgen/plugins/vite";
import { execSync } from "child_process";

export default defineConfig(({ command }) => {
  const plugins = [
    react(),
    icpBindgen({
      // The poker canister itself -- see ../pikopoker/src/main.mo.
      didFile: "../pikopoker/pikopoker.did",
      outDir: "./src/bindings/pikopoker",
    }),
    icpBindgen({
      // Same ICRC-1/ICRC-2 interface as the real PIKO ledger -- see
      // ../test-ledger/canister.yaml for why this project deploys its own
      // local-only copy rather than depending on piko-icp's.
      didFile: "../test-ledger/ledger.did",
      outDir: "./src/bindings/ledger",
    }),
  ];

  if (command !== "serve") {
    return { plugins };
  }

  // Local dev server: look up the local network's root key and this
  // project's own canister ids. No sibling `frontend`/`pikopay` lookup --
  // PikoPoker is a separate project on purpose (see ../icp.yaml).
  const environment = process.env.ICP_ENVIRONMENT || "local";
  const CANISTER_NAMES = ["pikopoker", "test-ledger"];

  const networkStatus = JSON.parse(
    execSync(`icp network status -e ${environment} --json`, { encoding: "utf-8" })
  );
  const rootKey: string = networkStatus.root_key;
  const proxyTarget: string = networkStatus.api_url;

  const idPairs = CANISTER_NAMES.map((name) => {
    try {
      const canisterId = execSync(`icp canister status ${name} -e ${environment} -i`, {
        encoding: "utf-8",
      }).trim();
      return `PUBLIC_CANISTER_ID:${name}=${canisterId}`;
    } catch {
      console.error(`
       Canister "${name}" not found in environment "${environment}"

       Before running the dev server, deploy it:

         icp deploy ${name} -e ${environment}
      `);
      process.exit(1);
    }
  });

  const server = {
    headers: {
      "Set-Cookie": `ic_env=${encodeURIComponent(
        `${idPairs.join("&")}&ic_root_key=${rootKey}`
      )}; SameSite=Lax;`,
    },
    proxy: {
      "/api": {
        target: proxyTarget,
        changeOrigin: true,
      },
    },
  };

  return { plugins, server };
});
