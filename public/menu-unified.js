/* ============================================ */
/* UNIFIED MENU CONTROL SCRIPT - ALL PAGES      */
/* Handles hamburger menu and navigation         */
/* ============================================ */

(function() {
    'use strict';

    // ==================== MENU STATE ==================== 
    let isMenuOpen = false;

    // ==================== DOM ELEMENTS ==================== 
    function getMenuElements() {
        const menuPanel = document.getElementById('menuPanel') || document.querySelector('.menu-panel');
        return {
            hamburgerBtn: document.getElementById('hamburgerBtn') || document.querySelector('.hamburger-menu'),
            hamburgerButtons: document.querySelectorAll('.hamburger-menu'),
            menuPanel,
            menuOverlay: document.querySelector('.menu-overlay'),
            menuItems: document.querySelectorAll('.menu-item'),
            menuClose: document.querySelector('.menu-close'),
            menuCloseButtons: document.querySelectorAll('.menu-close')
        };
    }

    // ==================== TOGGLE MENU ==================== 
    window.toggleHamburgerMenu = function() {
        if (isMenuOpen) {
            closeHamburgerMenu();
        } else {
            openHamburgerMenu();
        }
    };

    // ==================== OPEN MENU ==================== 
    function openHamburgerMenu() {
        const elements = getMenuElements();
        
        if (!elements.menuPanel) return;

        isMenuOpen = true;
        
        // Animate hamburger to X
        if (elements.hamburgerBtn) {
            elements.hamburgerBtn.classList.add('active');
        }

        // Slide menu in
        elements.menuPanel.classList.add('active');

        // Show overlay
        if (elements.menuOverlay) {
            elements.menuOverlay.classList.add('active');
        }

        // Prevent body scroll
        document.body.style.overflow = 'hidden';

        // Lock focus to menu (accessibility)
        trapFocus(elements.menuPanel);
    }

    // ==================== CLOSE MENU ==================== 
    window.closeHamburgerMenu = function() {
        const elements = getMenuElements();
        
        if (!elements.menuPanel) return;

        isMenuOpen = false;

        // Animate hamburger back
        if (elements.hamburgerBtn) {
            elements.hamburgerBtn.classList.remove('active');
        }

        // Slide menu out
        elements.menuPanel.classList.remove('active');

        // Hide overlay
        if (elements.menuOverlay) {
            elements.menuOverlay.classList.remove('active');
        }

        // Restore body scroll
        document.body.style.overflow = '';

        // Restore focus
        if (elements.hamburgerBtn) {
            elements.hamburgerBtn.focus();
        }
    };

    // ==================== INITIALIZE MENU ==================== 
    function initMenu() {
        const elements = getMenuElements();

        if (!elements.menuPanel) return;

        // Create overlay if it doesn't exist
        if (!elements.menuOverlay) {
            const overlay = document.createElement('div');
            overlay.className = 'menu-overlay';
            document.body.appendChild(overlay);
        }

        // Hamburger button clicks
        if (elements.hamburgerButtons.length > 0) {
            elements.hamburgerButtons.forEach(button => {
                button.addEventListener('click', window.toggleHamburgerMenu);
            });
        } else if (elements.hamburgerBtn) {
            elements.hamburgerBtn.addEventListener('click', window.toggleHamburgerMenu);
        }

        // Close button clicks
        if (elements.menuCloseButtons.length > 0) {
            elements.menuCloseButtons.forEach(button => {
                button.addEventListener('click', window.closeHamburgerMenu);
            });
        } else if (elements.menuClose) {
            elements.menuClose.addEventListener('click', window.closeHamburgerMenu);
        }

        // Overlay click
        const updatedOverlay = document.querySelector('.menu-overlay');
        if (updatedOverlay) {
            updatedOverlay.addEventListener('click', window.closeHamburgerMenu);
        }

        // Menu item clicks (auto-close)
        document.querySelectorAll('.menu-item').forEach(item => {
            item.addEventListener('click', function(e) {
                // Don't close for logout item (might need confirmation)
                if (!this.classList.contains('logout-item')) {
                    // Use setTimeout to allow navigation
                    setTimeout(window.closeHamburgerMenu, 100);
                }
            });
        });

        // Escape key to close menu
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && isMenuOpen) {
                window.closeHamburgerMenu();
            }
        });

        // Close menu on window resize
        window.addEventListener('resize', function() {
            if (window.innerWidth > 768 && isMenuOpen) {
                window.closeHamburgerMenu();
            }
        });
    }

    // ==================== FOCUS TRAP ==================== 
    function trapFocus(element) {
        const focusableElements = element.querySelectorAll(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );

        if (focusableElements.length === 0) return;

        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        element.addEventListener('keydown', function(e) {
            if (e.key !== 'Tab') return;

            if (e.shiftKey) {
                if (document.activeElement === firstElement) {
                    lastElement.focus();
                    e.preventDefault();
                }
            } else {
                if (document.activeElement === lastElement) {
                    firstElement.focus();
                    e.preventDefault();
                }
            }
        });
    }

    // ==================== UPDATE USER EMAIL ==================== 
    function getSupabaseClient() {
        if (window.__menuSupabaseClient) {
            return window.__menuSupabaseClient;
        }

        if (!window.supabase || !window.supabase.createClient) {
            return null;
        }

        if (!window.SUPABASE_URL || !window.SUPABASE_ANON_KEY) {
            return null;
        }

        window.__menuSupabaseClient = window.supabase.createClient(
            window.SUPABASE_URL,
            window.SUPABASE_ANON_KEY
        );

        return window.__menuSupabaseClient;
    }

    function updateUserEmail() {
        const menuUserEmail = document.getElementById('menuUserEmail');
        const userEmail = document.getElementById('userEmail');

        if (!menuUserEmail && !userEmail) return;

        const client = getSupabaseClient();
        if (!client || !client.auth || !client.auth.getSession) return;

        (async () => {
            try {
                const { data: { session } } = await client.auth.getSession();
                if (session?.user?.email) {
                    const email = session.user.email;
                    if (menuUserEmail) menuUserEmail.textContent = email;
                    if (userEmail) userEmail.textContent = email;
                }
            } catch (err) {
                console.error('Error updating user email:', err);
            }
        })();
    }

    // ==================== NAVBAR SCROLL EFFECT ==================== 
    function initNavbarScroll() {
        const navbar = document.querySelector('.navbar');
        if (!navbar) return;

        let lastScrollTop = 0;
        const scrollThreshold = 50;

        window.addEventListener('scroll', function() {
            const scrollTop = window.pageYOffset || document.documentElement.scrollTop;

            if (scrollTop > scrollThreshold) {
                navbar.classList.add('scrolled');
            } else {
                navbar.classList.remove('scrolled');
            }

            lastScrollTop = scrollTop;
        }, { passive: true });
    }

    // ==================== INITIALIZATION ON DOM READY ==================== 
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            initMenu();
            updateUserEmail();
            initNavbarScroll();
        });
    } else {
        initMenu();
        updateUserEmail();
        initNavbarScroll();
    }

    // ==================== EXPORT FUNCTIONS ==================== 
    window.initMenuSystem = function() {
        initMenu();
        updateUserEmail();
        initNavbarScroll();
    };
})();
