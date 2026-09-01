import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * The licence obligations, discharged where a user of the running service can
 * actually see them. `NOTICE` in the repo satisfies neither on its own: AGPL
 * §13 is about the people using the network service, and CC-BY-SA attribution
 * has to travel with the thing being shared.
 */
@Component({
  selector: 'pr-site-footer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <footer class="site-footer">
      <div class="inner">
        <p class="attribution">
          Match, tournament, and player data from
          <a href="https://liquipedia.net" rel="noopener noreferrer external" target="_blank">Liquipedia</a>,
          used under
          <a
            href="https://creativecommons.org/licenses/by-sa/3.0/us/"
            rel="license noopener noreferrer external"
            target="_blank"
            >CC BY-SA 3.0 US</a
          >. Changes were made: results and rosters are parsed into a relational schema, and the
          ratings and rankings shown here are computed by this project's own model, not by
          Liquipedia. Liquipedia is not affiliated with this project and does not endorse it. Data
          derived from Liquipedia is shared under the same licence.
        </p>

        <div class="stack">
          <p class="attribution">
            Team names and logos are the property of their respective organisations and of Riot
            Games. Not endorsed by Riot Games.
          </p>

          <!-- AGPL §13: running this over a network obliges us to offer users the
               corresponding source, which in practice is this link. -->
          <p class="source">
            PowerRanking is free software under
            <a
              href="https://www.gnu.org/licenses/agpl-3.0.html"
              rel="license noopener noreferrer external"
              target="_blank"
              >AGPL-3.0</a
            >.
            <a
              class="source__link"
              href="https://github.com/kehanks2/power-ranking"
              rel="noopener noreferrer external"
              target="_blank"
              >Source code</a
            >
          </p>
        </div>

        <p class="attribution">
          Built with
          <a href="https://claude.com/claude-code" rel="noopener noreferrer external" target="_blank"
            >Claude Code</a
          >. Anthropic's Claude wrote the code, the rating model and the words on this site. The
          direction, the decisions and the review are its maintainer's.
        </p>
      </div>
    </footer>
  `,
  styleUrl: './site-footer.component.scss',
})
export class SiteFooterComponent {}
