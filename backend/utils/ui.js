export const UI = {
    escapeHTML: (str) => {
        if (!str) return '';
        return str.replace(/[&<>"']/g, (m) => {
            const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };
            return map[m];
        });
    },

    toast: (message, type = 'info') => {
        let container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            container.className = 'fixed bottom-5 right-5 z-50 flex flex-col gap-2';
            document.body.appendChild(container);
        }

        const toast = document.createElement('div');
        const bgClass = type === 'success' ? 'bg-green-600' : type === 'error' ? 'bg-red-600' : 'bg-blue-600';
        toast.className = `${bgClass} text-white px-5 py-3 rounded-xl shadow-2xl font-semibold transition-all duration-300 transform translate-y-4 opacity-0`;
        toast.textContent = message;

        container.appendChild(toast);
        setTimeout(() => toast.classList.remove('translate-y-4', 'opacity-0'), 10);

        setTimeout(() => {
            toast.classList.add('opacity-0', 'translate-y-4');
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    },

    setLoading: (buttonElement, isLoading, originalText = 'Submit') => {
        if (!buttonElement) return;
        if (isLoading) {
            buttonElement.disabled = true;
            buttonElement.classList.add('opacity-50', 'cursor-not-allowed');
            buttonElement.innerHTML = `
                <svg class="animate-spin h-5 w-5 text-white inline mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg> Processing...`;
        } else {
            buttonElement.disabled = false;
            buttonElement.classList.remove('opacity-50', 'cursor-not-allowed');
            buttonElement.textContent = originalText;
        }
    }
};