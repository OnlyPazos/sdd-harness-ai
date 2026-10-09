/*
 * Button Component — design-system/components/button/button.js
 *
 * Custom element <ds-button> — Web Component vanilla con Shadow DOM.
 *
 * Requisitos en la página:
 *   <link rel="stylesheet" href="design-system/tokens/tokens.css">
 *   <script src="design-system/components/button/button.js"></script>
 * button.css NO se enlaza en la página: este script la carga dentro del
 * Shadow DOM, resolviendo su ruta relativa a este archivo.
 * (Si cargas el script como módulo o desde un bundle, define antes
 * window.DS_BUTTON_STYLES con la URL de button.css.)
 *
 * Atributos:
 *   variant="primary|secondary|outline|ghost"  (default: primary)
 *   size="sm|md|lg"                            (default: md)
 *   type="button|submit|reset"                 (default: button; submit/reset
 *                                               actúan sobre el <form> que lo contiene)
 *   disabled, loading, error, block            (booleanos)
 *   aria-label                                 (obligatorio si el botón no tiene texto)
 *
 * Eventos:
 *   click     — el nativo; no se emite si está disabled o loading.
 *   ds-click  — mismo momento que click, con detail.originalEvent.
 */

(function () {
  'use strict';

  const STYLE_URL =
    window.DS_BUTTON_STYLES ||
    new URL('button.css', (document.currentScript && document.currentScript.src) || location.href).href;

  const BOOLEAN_ATTRS = ['disabled', 'loading', 'error', 'block'];

  const template = document.createElement('template');
  template.innerHTML = `
    <link rel="stylesheet" href="${STYLE_URL}">
    <button class="ds-btn" part="button" type="button">
      <span class="ds-btn-spinner" aria-hidden="true"></span>
      <span class="ds-btn-label"><slot></slot></span>
    </button>
  `;

  class DSButton extends HTMLElement {
    static get observedAttributes() {
      return ['variant', 'size', 'aria-label', ...BOOLEAN_ATTRS];
    }

    constructor() {
      super();
      /* delegatesFocus: host.focus() y el foco por teclado van al <button> interno. */
      this.attachShadow({ mode: 'open', delegatesFocus: true });
      this.shadowRoot.appendChild(template.content.cloneNode(true));
      this._button = this.shadowRoot.querySelector('.ds-btn');

      /* Los listeners se registran una sola vez sobre nodos que viven tanto
         como el elemento, así que no hace falta quitarlos al desconectar. */
      this.addEventListener('click', (e) => this._guardClick(e), true);
      this._button.addEventListener('click', (e) => this._handleClick(e));
    }

    connectedCallback() {
      this._render();
      this._warnIfTokensMissing();
    }

    attributeChangedCallback(name, oldVal, newVal) {
      if (oldVal !== newVal) this._render();
    }

    _render() {
      const classes = ['ds-btn', `ds-btn--${this.variant}`];
      if (this.size !== 'md') classes.push(`ds-btn--${this.size}`);
      if (this.block) classes.push('ds-btn--block');
      if (this.error) classes.push('ds-btn--error');
      this._button.className = classes.join(' ');

      this._button.disabled = this.disabled || this.loading;
      this._toggleAttr('aria-busy', this.loading ? 'true' : null);

      /* Nombre accesible para botones sin texto (solo icono). */
      this._toggleAttr('aria-label', this.getAttribute('aria-label'));
    }

    _toggleAttr(name, value) {
      if (value === null) this._button.removeAttribute(name);
      else this._button.setAttribute(name, value);
    }

    /* Bloquea el click en fase de captura si el botón no está activo, para que
       ni los listeners del consumidor ni el form lo reciban. */
    _guardClick(e) {
      if (this.disabled || this.loading) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }

    _handleClick(e) {
      this.dispatchEvent(new CustomEvent('ds-click', {
        bubbles: true,
        composed: true,
        detail: { originalEvent: e },
      }));

      /* Un <button> dentro de Shadow DOM no puede enviar el form exterior. */
      const form = this.closest('form');
      if (!form) return;
      if (this.type === 'submit') form.requestSubmit();
      else if (this.type === 'reset') form.reset();
    }

    _warnIfTokensMissing() {
      if (DSButton._tokensChecked) return;
      DSButton._tokensChecked = true;
      if (!getComputedStyle(this).getPropertyValue('--ds-color-focus').trim()) {
        console.warn('<ds-button>: no se encuentran las variables --ds-*. Enlaza design-system/tokens/tokens.css en la página.');
      }
    }

    /* ── API JS ─────────────────────────────────────────────── */

    get variant() { return this.getAttribute('variant') || 'primary'; }
    set variant(v) { this.setAttribute('variant', v); }

    get size() { return this.getAttribute('size') || 'md'; }
    set size(s) { this.setAttribute('size', s); }

    get type() { return this.getAttribute('type') || 'button'; }
    set type(t) { this.setAttribute('type', t); }
  }

  /* Getters/setters booleanos reflejados en atributos. */
  BOOLEAN_ATTRS.forEach((name) => {
    Object.defineProperty(DSButton.prototype, name, {
      get() { return this.hasAttribute(name); },
      set(value) { this.toggleAttribute(name, Boolean(value)); },
    });
  });

  if (!customElements.get('ds-button')) {
    customElements.define('ds-button', DSButton);
  }
})();
