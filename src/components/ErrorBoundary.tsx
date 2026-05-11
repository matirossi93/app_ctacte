import { Component, type ReactNode, type ErrorInfo } from 'react';
import { AlertTriangle } from 'lucide-react';

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
}
interface State {
    hasError: boolean;
    error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
    state: State = { hasError: false, error: null };

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        console.error('[ErrorBoundary] Uncaught error:', error, info?.componentStack);
    }

    handleReload = () => {
        this.setState({ hasError: false, error: null });
        window.location.reload();
    };

    render() {
        if (!this.state.hasError) return this.props.children;
        if (this.props.fallback) return this.props.fallback;

        return (
            <div style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                minHeight: '100vh', padding: '32px 24px', textAlign: 'center',
                background: 'var(--color-bg, #F9EFE3)',
                color: 'var(--color-text, #1a1a1a)',
                fontFamily: 'system-ui, -apple-system, sans-serif',
                gap: 16,
            }}>
                <AlertTriangle size={48} color="#C8102E" />
                <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 600 }}>Algo salió mal</h1>
                <p style={{ margin: 0, maxWidth: 480, color: 'var(--color-text-muted, #5a4a42)' }}>
                    La aplicación encontró un error inesperado. Probá recargar la página.
                    Si el problema persiste, avisale a Matías.
                </p>
                {this.state.error?.message && (
                    <details style={{
                        maxWidth: 480, padding: '12px 16px', borderRadius: 8,
                        background: 'rgba(0,0,0,0.04)', textAlign: 'left',
                        fontSize: '0.85rem', fontFamily: 'monospace',
                    }}>
                        <summary style={{ cursor: 'pointer' }}>Detalle técnico</summary>
                        <code style={{ display: 'block', marginTop: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                            {this.state.error.message}
                        </code>
                    </details>
                )}
                <button onClick={this.handleReload} style={{
                    marginTop: 8, padding: '10px 24px', borderRadius: 8, border: 'none',
                    background: 'var(--color-primary, #06652F)', color: 'white',
                    fontWeight: 600, fontSize: '1rem', cursor: 'pointer',
                }}>
                    Recargar página
                </button>
            </div>
        );
    }
}
