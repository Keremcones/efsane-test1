// ============================================
// ERROR HANDLING & TOAST NOTIFICATION SYSTEM
// ============================================

class ToastManager {
    constructor() {
        this.container = null;
        this.toasts = [];
        // Eğer DOM hazır değilse, hazır olduğunda başlat
        if (document.body) {
            this.initContainer();
        } else {
            document.addEventListener('DOMContentLoaded', () => this.initContainer());
        }
    }

    initContainer() {
        if (!document.body) return; // Body henüz yüklenmemişse çık
        
        if (!document.getElementById('toast-container')) {
            const container = document.createElement('div');
            container.id = 'toast-container';
            container.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                z-index: 9999;
                display: flex;
                flex-direction: column;
                gap: 10px;
                max-width: 400px;
            `;
            document.body.appendChild(container);
            this.container = container;
        } else {
            this.container = document.getElementById('toast-container');
        }
    }

    show(message, type = 'info', duration = 5000) {
        const toastId = Date.now();
        
        const toast = document.createElement('div');
        toast.id = `toast-${toastId}`;
        
        const bgColor = {
            'success': '#10b981',
            'error': '#ef4444',
            'warning': '#f59e0b',
            'info': '#3b82f6'
        }[type] || '#3b82f6';
        
        const iconClass = {
            'success': 'fa-circle-check',
            'error': 'fa-circle-xmark',
            'warning': 'fa-triangle-exclamation',
            'info': 'fa-circle-info'
        }[type] || 'fa-circle-info';
        
        toast.style.cssText = `
            background-color: ${bgColor};
            color: white;
            padding: 14px 18px;
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            font-size: 14px;
            font-weight: 500;
            animation: slideIn 0.3s ease-out;
            display: flex;
            align-items: center;
            gap: 10px;
            word-wrap: break-word;
            max-width: 100%;
        `;
        
        toast.innerHTML = `
            <span style="flex-shrink: 0; font-size: 16px;">
                <i class="fa-solid ${iconClass}"></i>
            </span>
            <span style="flex: 1;">${message}</span>
            <button style="
                background: none;
                border: none;
                color: white;
                cursor: pointer;
                font-size: 18px;
                padding: 0;
                display: flex;
                align-items: center;
            " onclick="this.parentElement.remove()">×</button>
        `;
        
        this.container.appendChild(toast);
        this.toasts.push(toastId);
        
        if (duration > 0) {
            setTimeout(() => {
                const el = document.getElementById(`toast-${toastId}`);
                if (el) {
                    el.style.animation = 'slideOut 0.3s ease-out forwards';
                    setTimeout(() => el.remove(), 300);
                }
            }, duration);
        }
        
        return toastId;
    }

    success(message, duration = 5000) {
        return this.show(message, 'success', duration);
    }

    error(message, duration = 7000) {
        return this.show(message, 'error', duration);
    }

    warning(message, duration = 5000) {
        return this.show(message, 'warning', duration);
    }

    info(message, duration = 4000) {
        return this.show(message, 'info', duration);
    }

    remove(toastId) {
        const el = document.getElementById(`toast-${toastId}`);
        if (el) {
            el.style.animation = 'slideOut 0.3s ease-out forwards';
            setTimeout(() => el.remove(), 300);
        }
        this.toasts = this.toasts.filter(id => id !== toastId);
    }

    clear() {
        this.toasts.forEach(id => this.remove(id));
        this.toasts = [];
    }
}

// Global toast manager
const Toast = new ToastManager();

// Add CSS animations
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from {
            transform: translateX(400px);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
    
    @keyframes slideOut {
        from {
            transform: translateX(0);
            opacity: 1;
        }
        to {
            transform: translateX(400px);
            opacity: 0;
        }
    }
`;
document.head.appendChild(style);

// ============================================
// ERROR HANDLER WRAPPER
// ============================================

async function handleAsync(asyncFn, errorMessage = 'Bir hata oluştu') {
    try {
        return await asyncFn();
    } catch (error) {
        console.error(errorMessage, error);
        Toast.error(`${errorMessage}: ${error.message}`);
        throw error;
    }
}

// Global error handler
window.addEventListener('error', (event) => {
    console.error('Global error:', event.error);
    Toast.error(`Beklenmeyen hata: ${event.error?.message || 'Bilinmeyen hata'}`);
});

window.addEventListener('unhandledrejection', (event) => {
    console.error('Unhandled promise rejection:', event.reason);
    Toast.error(`Hata: ${event.reason?.message || 'Beklenmeyen bir hata oluştu'}`);
});

// Export for use
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        Toast,
        ToastManager,
        handleAsync
    };
}
