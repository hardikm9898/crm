/**
 * The shape every form on this app gets back from a server action.
 *
 * Kept apart from the server helper that produces it so a client component can import the type and
 * the initial value without dragging `next/headers` into the browser bundle — which is not a style
 * preference: the bundler refuses to build it.
 */
export type ActionState =
  | { status: 'idle' }
  | { status: 'success'; message: string }
  | {
      status: 'error';
      message: string;
      fieldErrors?: Record<string, string>;
      /**
       * What was submitted, echoed back so a refused form can re-fill itself.
       *
       * A server action re-renders the server component tree, which remounts the client form and
       * resets every uncontrolled input — so a refusal emptied the form and the person had to type
       * it all again. Found by submitting a two-digit phone number and watching eight fields clear.
       */
      values?: Record<string, string>;
    };

export const IDLE: ActionState = { status: 'idle' };
