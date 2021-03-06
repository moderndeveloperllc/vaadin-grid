/**
 * @license
 * Copyright (c) 2020 Vaadin Ltd.
 * This program is available under Apache License Version 2.0, available at https://vaadin.com/license/
 */
import { Debouncer } from '@polymer/polymer/lib/utils/debounce.js';
import { animationFrame, timeOut, microTask } from '@polymer/polymer/lib/utils/async.js';

const timeouts = {
  SCROLLING: 500,
  IGNORE_WHEEL: 500
};

/**
 * @polymerMixin
 */
export const ScrollMixin = (superClass) =>
  class ScrollMixin extends superClass {
    static get properties() {
      return {
        /**
         * Cached array of frozen cells
         * @private
         */
        _frozenCells: {
          type: Array,
          value: () => []
        },

        /** @private */
        _rowWithFocusedElement: Element,

        /** @private */
        _deltaYAcc: {
          type: Number,
          value: 0
        },

        /** @private */
        _useSticky: {
          type: Boolean,
          value:
            window.CSS &&
            window.CSS.supports &&
            (window.CSS.supports('position', 'sticky') || window.CSS.supports('position', '-webkit-sticky'))
        }
      };
    }

    static get observers() {
      return ['_scrollViewportHeightUpdated(_viewportHeight)'];
    }

    /**
     * Override (from iron-scroll-target-behavior) to avoid document scroll
     * @private
     */
    set _scrollTop(top) {
      this.$.table.scrollTop = top;
    }

    /** @private */
    get _scrollTop() {
      return this.$.table.scrollTop;
    }

    constructor() {
      super();
      this._scrollLineHeight = this._getScrollLineHeight();
    }

    /**
     * @returns {Number|undefined} - The browser's default font-size in pixels
     * @private
     */
    _getScrollLineHeight() {
      const el = document.createElement('div');
      el.style.fontSize = 'initial';
      el.style.display = 'none';
      document.body.appendChild(el);
      const fontSize = window.getComputedStyle(el).fontSize;
      document.body.removeChild(el);
      return fontSize ? window.parseInt(fontSize) : undefined;
    }

    /** @private */
    _scrollViewportHeightUpdated(_viewportHeight) {
      this._scrollPageHeight =
        _viewportHeight - this.$.header.clientHeight - this.$.footer.clientHeight - this._scrollLineHeight;
    }

    /** @protected */
    ready() {
      super.ready();

      // Preserve accessor to the legacy scrolling functionality
      this.$.outerscroller = document.createElement('div');

      this.scrollTarget = this.$.table;

      this.addEventListener('wheel', this._onWheel);

      this.$.items.addEventListener('focusin', (e) => {
        const itemsIndex = e.composedPath().indexOf(this.$.items);
        this._rowWithFocusedElement = e.composedPath()[itemsIndex - 1];
      });
      this.$.items.addEventListener('focusout', () => (this._rowWithFocusedElement = undefined));

      // Reordering the physical rows cancels the user's grab of the scroll bar handle on Safari.
      // Need to defer reordering until the user lets go of the scroll bar handle.
      this.scrollTarget.addEventListener('mousedown', () => (this.__mouseDown = true));
      this.scrollTarget.addEventListener('mouseup', () => {
        this.__mouseDown = false;
        if (this.__pendingReorder) {
          this.__pendingReorder = false;
          setTimeout(() => this._reorderRows(), timeouts.SCROLLING);
        }
      });
    }

    /**
     * Scroll to a specific row index in the virtual list. Note that the row index is
     * not always the same for any particular item. For example, sorting/filtering/expanding
     * or collapsing hierarchical items can affect the row index related to an item.
     *
     * @param {number} index Row index to scroll to
     */
    scrollToIndex(index) {
      this._accessIronListAPI(() => super.scrollToIndex(index));
    }

    /** @private */
    _onWheel(e) {
      if (e.ctrlKey || this._hasScrolledAncestor(e.target, e.deltaX, e.deltaY)) {
        return;
      }

      const table = this.$.table;

      let deltaY = e.deltaY;
      if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        // Scrolling by "lines of text" instead of pixels
        deltaY *= this._scrollLineHeight;
      } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        // Scrolling by "pages" instead of pixels
        deltaY *= this._scrollPageHeight;
      }

      if (this._wheelAnimationFrame) {
        // Skip new wheel events while one is being processed
        this._deltaYAcc += deltaY;
        e.preventDefault();
        return;
      }

      deltaY += this._deltaYAcc;
      this._deltaYAcc = 0;

      this._wheelAnimationFrame = true;
      this._debouncerWheelAnimationFrame = Debouncer.debounce(
        this._debouncerWheelAnimationFrame,
        animationFrame,
        () => (this._wheelAnimationFrame = false)
      );

      const momentum = Math.abs(e.deltaX) + Math.abs(deltaY);

      if (this._canScroll(table, e.deltaX, deltaY)) {
        e.preventDefault();
        table.scrollTop += deltaY;
        table.scrollLeft += e.deltaX;
        this._scrollHandler();
        this._hasResidualMomentum = true;

        this._ignoreNewWheel = true;
        this._debouncerIgnoreNewWheel = Debouncer.debounce(
          this._debouncerIgnoreNewWheel,
          timeOut.after(timeouts.IGNORE_WHEEL),
          () => (this._ignoreNewWheel = false)
        );
      } else if ((this._hasResidualMomentum && momentum <= this._previousMomentum) || this._ignoreNewWheel) {
        e.preventDefault();
      } else if (momentum > this._previousMomentum) {
        this._hasResidualMomentum = false;
      }
      this._previousMomentum = momentum;
    }

    /**
     * Determines if the element has an ancestor prior to this
     * cell content that handles the scroll delta
     * @private
     */
    _hasScrolledAncestor(el, deltaX, deltaY) {
      if (el.localName === 'vaadin-grid-cell-content') {
        return false;
      } else if (
        this._canScroll(el, deltaX, deltaY) &&
        ['auto', 'scroll'].indexOf(getComputedStyle(el).overflow) !== -1
      ) {
        return true;
      } else if (el !== this && el.parentElement) {
        return this._hasScrolledAncestor(el.parentElement, deltaX, deltaY);
      }
    }

    /**
     * Determines if the the given scroll deltas can be applied to the element
     * (fully or partially)
     * @private
     */
    _canScroll(el, deltaX, deltaY) {
      return (
        (deltaY > 0 && el.scrollTop < el.scrollHeight - el.offsetHeight) ||
        (deltaY < 0 && el.scrollTop > 0) ||
        (deltaX > 0 && el.scrollLeft < el.scrollWidth - el.offsetWidth) ||
        (deltaX < 0 && el.scrollLeft > 0)
      );
    }

    /** @private */
    _scheduleScrolling() {
      if (!this._scrollingFrame) {
        // Defer setting state attributes to avoid Edge hiccups
        this._scrollingFrame = requestAnimationFrame(() => this._toggleAttribute('scrolling', true, this.$.scroller));
      }
      this._debounceScrolling = Debouncer.debounce(this._debounceScrolling, timeOut.after(timeouts.SCROLLING), () => {
        cancelAnimationFrame(this._scrollingFrame);
        delete this._scrollingFrame;
        this._toggleAttribute('scrolling', false, this.$.scroller);
        this._reorderRows();
      });
    }

    /** @private */
    _afterScroll() {
      this._translateStationaryElements();

      if (!this.hasAttribute('reordering')) {
        this._scheduleScrolling();
      }

      this._updateOverflow();
    }

    /** @private */
    _updateOverflow() {
      // Set overflow styling attributes
      let overflow = '';
      const table = this.$.table;
      if (table.scrollTop < table.scrollHeight - table.clientHeight) {
        overflow += ' bottom';
      }

      if (table.scrollTop > 0) {
        overflow += ' top';
      }

      if (table.scrollLeft < table.scrollWidth - table.clientWidth) {
        overflow += ' right';
      }

      if (table.scrollLeft > 0) {
        overflow += ' left';
      }

      this._debounceOverflow = Debouncer.debounce(this._debounceOverflow, animationFrame, () => {
        const value = overflow.trim();
        if (value.length > 0 && this.getAttribute('overflow') !== value) {
          this.setAttribute('overflow', value);
        } else if (value.length == 0 && this.hasAttribute('overflow')) {
          this.removeAttribute('overflow');
        }
      });
    }

    /**
     * Correct order needed for preserving correct tab order between cell contents.
     * @private
     */
    _reorderRows() {
      if (this.__mouseDown) {
        this.__pendingReorder = true;
        return;
      }

      const body = this.$.items;
      const items = body.querySelectorAll('tr');
      if (!items.length) {
        return;
      }

      const adjustedVirtualStart = this._virtualStart + this._vidxOffset;

      // Which row to use as a target?
      const targetRow = this._rowWithFocusedElement || Array.from(items).filter((row) => !row.hidden)[0];
      if (!targetRow) {
        // All rows are hidden, don't reorder
        return;
      }

      // Where the target row should be?
      const targetPhysicalIndex = targetRow.index - adjustedVirtualStart;

      // Reodrer the DOM elements to keep the target row at the target physical index
      const delta = Array.from(items).indexOf(targetRow) - targetPhysicalIndex;
      if (delta > 0) {
        for (let i = 0; i < delta; i++) {
          body.appendChild(items[i]);
        }
      } else if (delta < 0) {
        for (let i = items.length + delta; i < items.length; i++) {
          body.insertBefore(items[i], items[0]);
        }
      }

      // Due to a rendering bug, reordering the rows can make the sticky header disappear on Safari
      // if the grid is used inside of a flex box. This is a workaround for the issue.
      if (this._safari) {
        const { transform } = this.$.header.style;
        this.$.header.style.transform = '';
        setTimeout(() => (this.$.header.style.transform = transform));
      }
    }

    /** @protected */
    _frozenCellsChanged() {
      this._debouncerCacheElements = Debouncer.debounce(this._debouncerCacheElements, microTask, () => {
        Array.from(this.shadowRoot.querySelectorAll('[part~="cell"]')).forEach(function (cell) {
          cell.style.transform = '';
        });
        this._frozenCells = Array.prototype.slice.call(this.$.table.querySelectorAll('[frozen]'));
        this._updateScrollerMeasurements();
        this._translateStationaryElements();
      });
      this._updateLastFrozen();
    }

    /** @protected */
    _updateScrollerMeasurements() {
      if (this._frozenCells.length > 0 && this.__isRTL) {
        this.__scrollerMetrics = {
          scrollWidth: this.$.table.scrollWidth,
          clientWidth: this.$.table.clientWidth
        };
      }
    }

    /** @protected */
    _updateLastFrozen() {
      if (!this._columnTree) {
        return;
      }

      const columnsRow = this._columnTree[this._columnTree.length - 1].slice(0);
      columnsRow.sort((a, b) => {
        return a._order - b._order;
      });
      const lastFrozen = columnsRow.reduce((prev, col, index) => {
        col._lastFrozen = false;
        return col.frozen && !col.hidden ? index : prev;
      }, undefined);
      if (lastFrozen !== undefined) {
        columnsRow[lastFrozen]._lastFrozen = true;
      }
    }

    /** @private */
    _translateStationaryElements() {
      const scrollLeft = Math.max(0, this._scrollLeft);
      const scrollTop = Math.max(0, this._scrollTop);

      let leftOffset = 0;
      let topOffset = 0;
      let footerOffset = 0;
      if (!this._useSticky) {
        leftOffset = scrollLeft;
        topOffset = scrollTop;
        footerOffset = this.$.table.clientHeight - this.$.footer.offsetHeight - this.$.footer.offsetTop;
      }

      this.$.header.style.transform = this._getTranslate(-scrollLeft + leftOffset, topOffset);
      this.$.footer.style.transform = this._getTranslate(-scrollLeft + leftOffset, topOffset + footerOffset);
      this.$.items.style.transform = this._getTranslate(-scrollLeft + leftOffset, 0);

      if (this._frozenCells.length > 0) {
        const x = this.__isRTL
          ? this.__getNormalizedScrollLeft(this.$.table) +
            this.__scrollerMetrics.clientWidth -
            this.__scrollerMetrics.scrollWidth
          : this._scrollLeft;
        const frozenCellTransform = this._getTranslate(x, 0);

        for (let i = 0; i < this._frozenCells.length; i++) {
          this._frozenCells[i].style.transform = frozenCellTransform;
        }
      }
    }

    /** @private */
    _getTranslate(x, y) {
      return `translate(${x}px, ${y}px)`;
    }
  };
