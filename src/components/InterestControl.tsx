import { useState } from 'react';
import { formatPercent } from '../utils/formatters';
import { Settings } from 'lucide-react';

interface InterestControlProps {
    currentRate: number;
    onRateChange: (newRate: number) => void;
}

export const InterestControl = ({ currentRate, onRateChange }: InterestControlProps) => {
    const [isOpen, setIsOpen] = useState(false);
    const [inputValue, setInputValue] = useState((currentRate * 100).toString());

    const handleApply = () => {
        const val = parseFloat(inputValue);
        if (!isNaN(val) && val >= 0) {
            onRateChange(val / 100);
            setIsOpen(false);
        }
    };

    return (
        <div className="interest-control-container">
            <button
                className="glass btn-icon"
                onClick={() => setIsOpen(!isOpen)}
                title="Ajustar Tasa de Interés por Mora"
            >
                <Settings size={20} />
                <span>Tasa: {formatPercent(currentRate)}</span>
            </button>

            {isOpen && (
                <div className="interest-popover glass">
                    <h4>Ajustar Tasa de Interés</h4>
                    <p className="subtitle">Se aplicará a facturas vencidas</p>
                    <div className="input-group">
                        <input
                            type="number"
                            step="0.1"
                            value={inputValue}
                            onChange={(e) => setInputValue(e.target.value)}
                            className="interest-input"
                        />
                        <span className="percent-symbol">%</span>
                    </div>
                    <button className="btn-primary" onClick={handleApply}>
                        Aplicar
                    </button>
                </div>
            )}
        </div>
    );
};
