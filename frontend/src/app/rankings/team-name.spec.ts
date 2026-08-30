import { displayTeamName } from './team-name';

describe('displayTeamName', () => {
  it('leaves a name inside the limit exactly as it is', () => {
    expect(displayTeamName('GAM Esports')).toBe('GAM Esports');
    expect(displayTeamName('ThunderTalk Gaming')).toBe('ThunderTalk Gaming');
    expect(displayTeamName('Hanwha Life Esports')).toBe('Hanwha Life Esports');
    expect(displayTeamName('Chiefs Esports Club')).toBe('Chiefs Esports Club');
  });

  // The one name in the database that needs it: 29 characters against 19 for
  // the next longest, which is what would otherwise size the whole column.
  it('drops a trailing generic word from an over-long name', () => {
    expect(displayTeamName('Fukuoka SoftBank HAWKS gaming')).toBe('Fukuoka SoftBank HAWKS');
  });

  it('matches the suffix whatever its case', () => {
    expect(displayTeamName('Something Rather Long ESPORTS')).toBe('Something Rather Long');
  });

  it('leaves an over-long name that has no generic suffix alone', () => {
    const name = 'Twenty Three Characters';
    expect(name.length).toBeGreaterThan(22);
    expect(displayTeamName(name)).toBe(name);
  });

  // Only a whole trailing WORD goes. Without the space boundary this would eat
  // the tail of any name that happens to end in those letters.
  it('only strips a suffix that stands as its own word', () => {
    expect(displayTeamName('SuperLongOrganisationGaming')).toBe('SuperLongOrganisationGaming');
  });

  it('handles the null a roster row can carry', () => {
    expect(displayTeamName(null)).toBe('');
  });
});
