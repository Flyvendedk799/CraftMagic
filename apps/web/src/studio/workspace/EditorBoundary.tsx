import { Component, type ErrorInfo, type ReactNode } from 'react';
import { StudioIcon } from './Icon.js';
interface Props {
  children: ReactNode;
  documentKey: string;
  onOpenFiles: () => void;
}
interface State {
  error: string | null;
  documentKey: string;
}
/** Keep navigation and file recovery available if one editor fails to render. No automatic reset or deletion. */
export class EditorBoundary extends Component<Props, State> {
  override state: State = { error: null, documentKey: this.props.documentKey };
  static getDerivedStateFromError(error: unknown) {
    return {
      error:
        error instanceof Error
          ? error.message
          : 'The editor could not render this document.',
    };
  }
  static getDerivedStateFromProps(props: Props, state: State) {
    return props.documentKey !== state.documentKey
      ? { documentKey: props.documentKey, error: null }
      : null;
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Studio editor failed', error, info.componentStack);
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="workspace-editor-error" role="alert">
        <StudioIcon name="warning" />
        <h2>This editor couldn’t open</h2>
        <p>
          Your saved files have not been deleted. Retry the editor, or open
          another document from your work.
        </p>
        <div>
          <button onClick={() => this.setState({ error: null })}>
            Retry editor
          </button>
          <button onClick={this.props.onOpenFiles}>Open your work</button>
        </div>
        <details>
          <summary>Technical details</summary>
          <p>{this.state.error}</p>
        </details>
      </div>
    );
  }
}
