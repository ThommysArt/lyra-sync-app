import {
  RouterProvider,
  createHashHistory,
  createRouter,
} from "@tanstack/react-router";
import ReactDOM from "react-dom/client";

import Loader from "./components/loader";
import { routeTree } from "./routeTree.gen";

/**
 * Packaged Electron loads the UI via file:// (loadFile). Browser history then
 * sees pathname like ".../web-dist/index.html" and no route matches → Not Found.
 * Hash history keeps routes as #/ , #/settings, etc. under file://.
 * Dev (http://localhost:3001) and the web/PWA build keep clean path URLs.
 */
const useHashHistory =
  typeof window !== "undefined" && window.location.protocol === "file:";

const router = createRouter({
  routeTree,
  history: useHashHistory ? createHashHistory() : undefined,
  defaultPreload: "intent",
  scrollRestoration: true,
  defaultPendingComponent: () => <Loader />,
  context: {},
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("app");

if (!rootElement) {
  throw new Error("Root element not found");
}

if (!rootElement.innerHTML) {
  const root = ReactDOM.createRoot(rootElement);
  root.render(<RouterProvider router={router} />);
}
