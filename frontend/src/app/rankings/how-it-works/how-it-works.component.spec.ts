import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { HowItWorksComponent } from './how-it-works.component';
import { BOARD_SCOPES } from '../models';

describe('HowItWorksComponent', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HowItWorksComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  function render(boards: { scope: string; lastUpdated: string | null }[] = []) {
    const fixture = TestBed.createComponent(HowItWorksComponent);
    fixture.detectChanges();
    http.expectOne((r) => r.url.endsWith('/leagues.json')).flush([]);
    http.expectOne((r) => r.url.endsWith('/boards-updated.json')).flush(boards);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('lists every board, so none of them is silently undocumented', () => {
    const rows = render().querySelectorAll('.boards tbody tr');
    expect(rows.length).toBe(BOARD_SCOPES.length);
  });

  it('marks a board that has never updated rather than leaving the cell empty', () => {
    const dom = render([{ scope: 'LCK', lastUpdated: '2026-08-16' }]);
    const when = [...dom.querySelectorAll('.boards tbody .when')].map((c) => c.textContent!.trim());
    expect(when).toContain('16 Aug 2026');
    expect(when.filter((text) => text === '—').length).toBe(BOARD_SCOPES.length - 1);
  });

  it('has a heading for every entry in its own table of contents', () => {
    const dom = render();
    const links = [...dom.querySelectorAll('.toc a')];
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      const id = link.getAttribute('href')!.split('#')[1];
      expect(id).withContext(`"${link.textContent}" links nowhere`).toBeTruthy();
      expect(dom.querySelector(`h3#${id}`))
        .withContext(`no heading with id "${id}"`)
        .not.toBeNull();
    }
  });
});
