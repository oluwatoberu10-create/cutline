/** What every server action returns to its form. */
export type ActionState = {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  /** Shown as a success toast. */
  message?: string;
  /** Extra data for the form (e.g. a one-time invite link to display). */
  data?: Record<string, string | number | boolean | null>;
  /** Changes on every completion so effects fire even for identical results. */
  at?: number;
};

export const initialState: ActionState = {};
