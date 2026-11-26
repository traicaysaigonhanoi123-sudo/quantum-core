/* ==========================================================================
   QUANTUM CORE // GSAP Motion Controller (prefers-reduced-motion compliant)
   Safely registers available GSAP 3.15 CDN plugins with graceful offline fallback
   ========================================================================== */

(function (global) {
  'use strict';

  function reducedMotion() {
    return typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function initGsapPlugins() {
    const g = global.gsap;
    if (!g) return null;
    const candidates = [
      global.CustomEase,
      global.CustomBounce,
      global.CustomWiggle,
      global.Flip,
      global.DrawSVGPlugin,
      global.ScrambleTextPlugin,
      global.ScrollTrigger
    ].filter(Boolean);
    if (candidates.length > 0 && typeof g.registerPlugin === 'function') {
      try { g.registerPlugin(...candidates); } catch (_) {}
    }
    return g;
  }

  class MotionController {
    constructor() {
      this.gsap = initGsapPlugins();
    }

    animateBoot() {
      if (!this.gsap || reducedMotion()) return;
      try {
        this.gsap.from('.panel', {
          y: 10,
          opacity: 0,
          duration: 0.32,
          stagger: 0.03,
          ease: 'power2.out',
          clearProps: 'transform,opacity'
        });
      } catch (_) {}
    }

    animateModalOpen(el) {
      if (!el || !this.gsap || reducedMotion()) return;
      try {
        this.gsap.fromTo(
          el,
          { scale: 0.97, opacity: 0 },
          { scale: 1, opacity: 1, duration: 0.16, ease: 'power2.out', clearProps: 'transform' }
        );
      } catch (_) {}
    }

    wiggleReject(el) {
      if (!el || !this.gsap || reducedMotion()) return;
      try {
        this.gsap.fromTo(
          el,
          { x: -6 },
          { x: 0, duration: 0.35, ease: 'elastic.out(1, 0.3)', clearProps: 'transform' }
        );
      } catch (_) {}
    }
  }

  global.QuantumMotionController = MotionController;
})(window);
