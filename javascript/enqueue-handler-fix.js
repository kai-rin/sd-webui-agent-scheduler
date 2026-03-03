// Fix for Gradio config race condition.
// When the server starts, bind_enqueue_button runs in on_app_started (after launch).
// If the browser loads the page before on_app_started fires, the Gradio config
// doesn't include the Enqueue click handler, so clicking the button does nothing.
// This script detects that condition and reloads the page once.
(function () {
    if (typeof onUiLoaded !== 'function') return;

    onUiLoaded(function () {
        ['txt2img_enqueue', 'img2img_enqueue'].forEach(function (id) {
            var btn = gradioApp().querySelector('#' + id);
            if (!btn) return;

            btn.addEventListener('click', function handler() {
                // submit_enqueue changes button text to "Queued" immediately.
                // If the Gradio handler is properly bound, the text will change
                // within a few milliseconds. If not, it stays as "Enqueue".
                setTimeout(function () {
                    if (btn.innerText === 'Enqueue') {
                        // Gradio handler didn't fire — config was stale. Reload once.
                        console.log('[AgentScheduler] Enqueue handler not bound, reloading page to pick up updated config...');
                        location.reload();
                    }
                    // Remove this listener regardless — either it worked or we reloaded.
                    btn.removeEventListener('click', handler);
                }, 300);
            });
        });
    });
})();
