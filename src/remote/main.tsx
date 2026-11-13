import { createRoot } from "react-dom/client";
import "./remote.css";
import { Remote } from "./Remote";

createRoot(document.getElementById("remote")!).render(<Remote />);

// Keeps the page openable while the Mac is away (see public/remote-sw.js).
if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/remote-sw.js").catch(() => {});
