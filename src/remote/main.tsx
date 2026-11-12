import { createRoot } from "react-dom/client";
import "./remote.css";
import { Remote } from "./Remote";

createRoot(document.getElementById("remote")!).render(<Remote />);
