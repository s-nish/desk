import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import "./themes.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);
