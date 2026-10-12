/**
 * Layout analysis stub — spatial structure of pages / tables (future group).
 */

export type LayoutBlock = {
  type: "text" | "table" | "header" | "footer" | "unknown";
  page: number | null;
  text: string | null;
  bbox: [number, number, number, number] | null;
};

export type LayoutAnalysisResult = {
  blocks: LayoutBlock[];
  page_count: number | null;
};

export async function analyzeLayout(_input: {
  text?: string | null;
  localPath?: string | null;
}): Promise<LayoutAnalysisResult> {
  throw Object.assign(new Error("Layout analysis is not implemented in Group 1"), {
    code: "LAYOUT_NOT_IMPLEMENTED",
  });
}
