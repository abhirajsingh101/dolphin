/* The chat's shapes, shared by the workspace and the components it renders. */
export type ToolActivity = { id: string; tool: string; status: string; arguments: Record<string, unknown>; result: unknown };
export type Message = { id: string; created_at?: string; role: 'user' | 'assistant'; text: string; payload?: { work_summary_receipt?: string; engine?: { provider: string; model: string; fallback: boolean } | null; uncertainty_note?: string | null; tool_activity?: ToolActivity[] } };
export type TrackedWork = { id: string; project_id: string; session_name: string; state: string; finished_at: string | null; summary_status?: string | null };
export type Thread = { id: string; title: string };
