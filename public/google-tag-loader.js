(function () {
    var gtmId = String(window.GTM_CONTAINER_ID || window.__ENV_GTM_CONTAINER_ID || '').trim();
    var isValidGtmId = /^GTM-[A-Z0-9]+$/i.test(gtmId);

    if (isValidGtmId) {
        if (window.__GTM_LOADED__ === gtmId) return;

        window.__GTM_LOADED__ = gtmId;
        window.dataLayer = window.dataLayer || [];
        window.dataLayer.push({
            'gtm.start': new Date().getTime(),
            event: 'gtm.js'
        });

        var firstScript = document.getElementsByTagName('script')[0];
        var gtmScript = document.createElement('script');
        gtmScript.async = true;
        gtmScript.src = 'https://www.googletagmanager.com/gtm.js?id=' + encodeURIComponent(gtmId);
        if (firstScript && firstScript.parentNode) {
            firstScript.parentNode.insertBefore(gtmScript, firstScript);
        } else {
            document.head.appendChild(gtmScript);
        }

        var injectNoScript = function () {
            if (!document.body || document.getElementById('gtm-noscript-frame')) return;
            var noScript = document.createElement('noscript');
            var iframe = document.createElement('iframe');
            iframe.id = 'gtm-noscript-frame';
            iframe.src = 'https://www.googletagmanager.com/ns.html?id=' + encodeURIComponent(gtmId);
            iframe.height = '0';
            iframe.width = '0';
            iframe.style.display = 'none';
            iframe.style.visibility = 'hidden';
            noScript.appendChild(iframe);
            document.body.insertBefore(noScript, document.body.firstChild);
        };

        if (document.body) {
            injectNoScript();
        } else {
            document.addEventListener('DOMContentLoaded', injectNoScript, { once: true });
        }
        return;
    }

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
