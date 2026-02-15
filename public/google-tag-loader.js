(function () {
    var measurementId = String(window.GA_MEASUREMENT_ID || window.__ENV_GA_MEASUREMENT_ID || '').trim();
    var isValidId = /^(G|AW|GT)-[A-Z0-9]+$/i.test(measurementId);

    if (!isValidId) return;
    if (window.__GOOGLE_TAG_LOADED__ === measurementId) return;

    window.__GOOGLE_TAG_LOADED__ = measurementId;
    window.dataLayer = window.dataLayer || [];

    function gtag() {
        window.dataLayer.push(arguments);
    }

    window.gtag = window.gtag || gtag;

    var script = document.createElement('script');
    script.async = true;
    script.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(measurementId);
    document.head.appendChild(script);

    window.gtag('js', new Date());
    window.gtag('config', measurementId, {
        anonymize_ip: true,
        send_page_view: true
    });
})();
