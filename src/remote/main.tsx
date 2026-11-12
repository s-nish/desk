import { createRoot } from "react-dom/client";
import "../notch/notch.css";
import "./remote.css";
import { Remote } from "./Remote";

createRoot(document.getElementById("remote")!).render(<Remote />);
