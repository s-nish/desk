/** Original and neutral interface palettes, shared by settings and preference validation. */
export const THEMES = [
  { id: "black", name: "Black", description: "Pure black. Crisp white.", bg: "#000000", surface: "#0b0b0b", accent: "#fafafa", light: false },
  { id: "obsidian", name: "Obsidian", description: "Deep ink. Quiet separation.", bg: "#101010", surface: "#171717", accent: "#f5f5f5", light: false },
  { id: "graphite-refined", name: "Graphite", description: "Balanced charcoal.", bg: "#202020", surface: "#282828", accent: "#f5f5f5", light: false },
  { id: "dim-soft", name: "Dim Soft", description: "Soft grey for late hours.", bg: "#303030", surface: "#383838", accent: "#f5f5f5", light: false },
  { id: "paper", name: "Light", description: "White paper. Sharp ink.", bg: "#ffffff", surface: "#f5f5f5", accent: "#171717", light: true },
  { id: "porcelain", name: "Porcelain", description: "A softer shade of white.", bg: "#f5f5f5", surface: "#ebebeb", accent: "#171717", light: true },
  { id: "silver", name: "Silver", description: "Brushed, understated grey.", bg: "#e8e8e8", surface: "#dedede", accent: "#171717", light: true },
  { id: "mist", name: "Mist", description: "Low glare. Deep black text.", bg: "#d8d8d8", surface: "#cecece", accent: "#111111", light: true },
  { id: "graphite", name: "Charcoal", description: "Original Dark Modern greys", bg: "#1f1f1f", surface: "#181818", accent: "#eeeeee", light: false },
  { id: "dim", name: "Dim", description: "Original Dark+ greys", bg: "#1e1e1e", surface: "#252526", accent: "#e8e8e8", light: false },
  { id: "graphite-classic", name: "Graphite Classic", description: "The original cool graphite", bg: "#111214", surface: "#15171a", accent: "#b6c5ff", light: false },
  { id: "midnight", name: "Midnight", description: "A little deeper after dark", bg: "#0e1524", surface: "#121c2e", accent: "#91baff", light: false },
  { id: "forest", name: "Forest", description: "A calmer kind of workspace", bg: "#101a17", surface: "#15211c", accent: "#a6d8b5", light: false },
  { id: "paper-warm", name: "Paper", description: "Light, warm, and clear", bg: "#faf9f6", surface: "#f3f2ed", accent: "#52633d", light: true },
  { id: "slate", name: "Slate", description: "Cool blue-grey, easy on the eyes", bg: "#15191f", surface: "#1b2027", accent: "#c9d6e6", light: false },
  { id: "espresso", name: "Espresso", description: "Warm roast browns", bg: "#1a1613", surface: "#211c18", accent: "#ead6bd", light: false },
  { id: "ocean", name: "Ocean", description: "Deep teal, calm water", bg: "#0c1a1c", surface: "#112225", accent: "#a0d9d3", light: false },
  { id: "rosewood", name: "Rosewood", description: "Dark wood with a blush", bg: "#1b1416", surface: "#231a1d", accent: "#efbcc6", light: false },
  { id: "sepia", name: "Sepia", description: "Old paper, brown ink", bg: "#f6efe2", surface: "#ede4d3", accent: "#6b4e2e", light: true },
  { id: "glacier", name: "Glacier", description: "Crisp, cool and bright", bg: "#f4f7fa", surface: "#e9eef3", accent: "#2d4a63", light: true },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];
