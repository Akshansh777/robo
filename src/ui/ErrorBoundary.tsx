import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; onReset: () => void },
  State
> {
  constructor(props: { children: React.ReactNode; onReset: () => void }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      message: error?.message || 'Unexpected rendering error occurred.',
    };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#0A0B0F',
            color: '#F2EFE6',
            padding: 24,
          }}
        >
          <div className="liquid-glass" style={{ maxWidth: 460, padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#FF5A4E' }}>
              <AlertTriangle size={20} />
              <span className="display-heading" style={{ fontSize: 18 }}>
                Arena Interface Recovery
              </span>
            </div>
            <p style={{ color: 'rgba(242,239,230,0.75)', lineHeight: 1.5, marginTop: 12 }}>
              The UI layer caught an exception while rendering state: <code>{this.state.message}</code>
            </p>
            <button
              className="glass-btn glass-btn-accent"
              style={{ marginTop: 14 }}
              onClick={() => {
                this.setState({ hasError: false, message: '' });
                this.props.onReset();
              }}
            >
              <RotateCcw size={14} />
              Reset Arena State
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
