/*
--------------------------------------------------------------
  Template Name: Soyuz - Bootstrap 4x Admin Dashboard Template
  File: Core JS File
--------------------------------------------------------------
 */
"use strict";
(function ($) {
    function isMobile() {
        return window.matchMedia('(max-width: 767.98px)').matches;
    }

    function setMobileIcons(open) {
        $('.topbar-mobile .menu-hamburger .menu-hamburger-collapse').toggle(!open);
        $('.topbar-mobile .menu-hamburger .menu-hamburger-close').toggle(open);
        $('.topbar-mobile .menu-hamburger').attr('aria-expanded', open ? 'true' : 'false');
        $('.mobile-tab-more').attr('aria-expanded', open ? 'true' : 'false');
    }

    function updateMobileTabs() {
        var hash = String(window.location.hash || '');
        var matches = {
            dashboard: /^#\/dashboard(?:\/|$)/.test(hash),
            sell: /^#\/sales\/new(?:\/|$)/.test(hash),
            items: /^#\/items(?:\/|$)/.test(hash),
            customers: /^#\/customers(?:\/|$)/.test(hash),
            ai: /^#\/ai(?:\/|$)/.test(hash)
        };
        var any = false;
        $.each(matches, function (tab, on) {
            if (on) { any = true; }
            $('.mobile-tab[data-tab="' + tab + '"]').toggleClass('is-active', on);
        });
        if (!hash || hash === '#' || hash === '#/') {
            $('.mobile-tab[data-tab="dashboard"]').addClass('is-active');
            any = true;
        }
        $('.mobile-tab-more').toggleClass('is-active', !any || $('body').hasClass('mobile-nav-open'));
    }

    function closeMobileNav() {
        $('body').removeClass('mobile-nav-open');
        setMobileIcons(false);
        updateMobileTabs();
    }

    function toggleMobileNav() {
        var open = !$('body').hasClass('mobile-nav-open');
        $('body').toggleClass('mobile-nav-open', open);
        setMobileIcons(open);
        updateMobileTabs();
    }

    $(document).ready(function () {
        /* -- Menu Hamburger -- */
        $(".menu-hamburger").on("click", function (e) {
            e.preventDefault();
            if (isMobile()) {
                toggleMobileNav();
            } else {
                $("body").toggleClass("toggle-menu");
                $(".topbar .menu-hamburger img").toggle();
            }
        });

        /* -- Menu Topbar Hamburger (kept for other shells) -- */
        $(".topbar-toggle-hamburger").on("click", function (e) {
            e.preventDefault();
            $("body").toggleClass("topbar-toggle-menu");
            $(".topbar-toggle-hamburger img").toggle();
        });

        $(document).on('click', '.mobile-nav-scrim, .mobile-nav-close', function (e) {
            e.preventDefault();
            closeMobileNav();
        });

        $(document).on('click', '.mobile-tab-more', function (e) {
            e.preventDefault();
            toggleMobileNav();
        });

        $(document).on('click', '.mobile-tabbar a.mobile-tab', function () {
            closeMobileNav();
        });

        $(document).on('click', '.leftbar a[href^="#/"]', function () {
            closeMobileNav();
        });

        $(document).on('keydown', function (e) {
            if (e.key === 'Escape' || e.keyCode === 27) { closeMobileNav(); }
        });

        $(window).on('hashchange', function () {
            closeMobileNav();
        });

        $(window).on('resize', function () {
            if (!isMobile()) {
                closeMobileNav();
                $('body').removeClass('toggle-menu');
            } else {
                $('body').removeClass('toggle-menu');
                if (!$('body').hasClass('mobile-nav-open')) { setMobileIcons(false); }
            }
            updateMobileTabs();
        });

        /* Keep the phone navigation outside the scrolling content shell so
           fixed positioning is never clipped by a page container. */
        $('.mobile-tabbar, .mobile-nav-scrim').appendTo('body');

        updateMobileTabs();

        /* -- Bootstrap Popover -- */
        $('[data-toggle="popover"]').popover();
        /* -- Bootstrap Tooltip -- */
        $('[data-toggle="tooltip"]').tooltip();
    });
})(jQuery);
