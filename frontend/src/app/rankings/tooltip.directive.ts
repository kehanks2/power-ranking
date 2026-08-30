import { Directive, ElementRef, inject, input, DestroyRef, DOCUMENT } from '@angular/core';

/**
 * A styled tooltip, replacing the native `title`.
 *
 * `title` is drawn by the OS: ~11px, its own colours, a delay we cannot set,
 * and no way to match the rest of the page. It also never appears for keyboard
 * users. This renders our own instead, on hover and on focus, dismissible with
 * Escape.
 *
 * The bubble is appended to `<body>` rather than positioned inside the host,
 * because the boards clip their overflow (`overflow: clip` on the table
 * wrapper, which is what keeps the sticky header working) and an absolutely
 * positioned child would be cut off at the cell edge.
 */
@Directive({
  selector: '[prTooltip]',
  host: {
    '(pointerenter)': 'show()',
    '(pointerleave)': 'hide()',
    '(focusin)': 'show()',
    '(focusout)': 'hide()',
    '(keydown.escape)': 'hide()',
    '[attr.aria-describedby]': 'bubble ? id : null',
  },
})
export class TooltipDirective {
  readonly prTooltip = input<string | null | undefined>('');

  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly document = inject(DOCUMENT);
  protected bubble: HTMLElement | null = null;
  protected readonly id = `pr-tip-${Math.random().toString(36).slice(2, 9)}`;

  constructor() {
    // A tooltip outlives its trigger otherwise: the boards swap every row on a
    // board change, and a hidden bubble left in <body> would never be reclaimed.
    inject(DestroyRef).onDestroy(() => this.hide());
  }

  protected show(): void {
    const text = this.prTooltip();
    if (!text || this.bubble) return;

    const bubble = this.document.createElement('div');
    bubble.className = 'pr-tooltip';
    bubble.id = this.id;
    bubble.setAttribute('role', 'tooltip');
    bubble.textContent = text;
    this.document.body.appendChild(bubble);
    this.bubble = bubble;
    this.position(bubble);
  }

  protected hide(): void {
    this.bubble?.remove();
    this.bubble = null;
  }

  /**
   * Above the trigger, centred, flipped below when there is no room and nudged
   * back inside the viewport when centring would overflow it -- a tooltip on
   * the first or last column otherwise renders half off-screen.
   */
  private position(bubble: HTMLElement): void {
    const anchor = this.host.nativeElement.getBoundingClientRect();
    const box = bubble.getBoundingClientRect();
    const margin = 8;

    let top = anchor.top - box.height - margin;
    if (top < margin) top = anchor.bottom + margin;

    let left = anchor.left + anchor.width / 2 - box.width / 2;
    left = Math.max(margin, Math.min(left, this.document.documentElement.clientWidth - box.width - margin));

    bubble.style.top = `${top + window.scrollY}px`;
    bubble.style.left = `${left + window.scrollX}px`;
  }
}
