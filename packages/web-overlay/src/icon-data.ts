import {
  Check,
  Component,
  Eraser,
  ListTodo,
  Menu,
  MousePointer2,
  Paperclip,
  Pencil,
  Redo2,
  Scan,
  SlidersHorizontal,
  Square,
  SquareDashed,
  Undo2,
  X,
  type IconNode,
} from "lucide";

function escapeAttribute(value: string | number): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderLucideIcon(nodes: IconNode): string {
  const children = nodes
    .map(([tag, attributes]) => {
      const serializedAttributes = Object.entries(attributes)
        .map(
          ([name, value]) =>
            `${name}="${escapeAttribute(value as string | number)}"`,
        )
        .join(" ");
      return `<${tag} ${serializedAttributes}></${tag}>`;
    })
    .join("");

  return `<svg class="vip-icon" data-icon-source="lucide" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${children}</svg>`;
}

// ShadCN uses Lucide for its interface icons. Keeping only Lucide icon data in
// this module preserves the original 24 x 24 proportions and gives every
// toolbar state one predictable currentColor implementation.
export const ICONS = {
  menu: renderLucideIcon(Menu),
  undo: renderLucideIcon(Undo2),
  redo: renderLucideIcon(Redo2),
  select: renderLucideIcon(MousePointer2),
  pencil: renderLucideIcon(Pencil),
  square: renderLucideIcon(Square),
  frame: renderLucideIcon(SquareDashed),
  clear: renderLucideIcon(Eraser),
  screenshot: renderLucideIcon(Scan),
  figma: renderLucideIcon(Component),
  tasks: renderLucideIcon(ListTodo),
  settings: renderLucideIcon(SlidersHorizontal),
  paperclip: renderLucideIcon(Paperclip),
  check: renderLucideIcon(Check),
  close: renderLucideIcon(X),
} as const;
