#!/usr/bin/env python3
"""
scholar — Academic paper search via OpenAlex API.
Search 200M+ works, get abstracts, BibTeX citations, and PDF links.
No API key required.

Usage:
    scholar.py search "query"                    # Search papers
    scholar.py search "query" --limit 5          # Limit results
    scholar.py search "query" --year-from 2020   # Year filter
    scholar.py search "query" --sort citations   # Sort by citations
    scholar.py paper "title or DOI"              # Paper details
    scholar.py cite "title or DOI"               # BibTeX citation
"""

import sys
import os
import argparse
import json
import time
import re
from typing import List, Dict, Optional

try:
    import requests
except ImportError:
    print("Error: 'requests' library required. Install with: pip install requests")
    sys.exit(1)


class Colors:
    """Terminal color support with NO_COLOR and non-TTY awareness."""

    def __init__(self):
        self.enabled = os.environ.get('NO_COLOR') is None and sys.stdout.isatty()

    def apply(self, text: str, code: str) -> str:
        return f"\033[{code}m{text}\033[0m" if self.enabled else text

    def bold(self, t): return self.apply(t, "1")
    def blue(self, t): return self.apply(t, "34")
    def green(self, t): return self.apply(t, "32")
    def yellow(self, t): return self.apply(t, "33")
    def red(self, t): return self.apply(t, "31")
    def dim(self, t): return self.apply(t, "2")


colors = Colors()


def cleanup_text(text: str) -> str:
    if not text:
        return ""
    return re.sub(r'\s+', ' ', text.strip()).strip()


def truncate_text(text: str, max_length: int) -> str:
    text = cleanup_text(text)
    if len(text) <= max_length:
        return text
    return text[:max_length - 3] + "..."


def reconstruct_abstract(inverted_index: Dict[str, List[int]]) -> str:
    """Reconstruct abstract from OpenAlex inverted index format."""
    if not inverted_index:
        return ""
    word_positions = []
    for word, positions in inverted_index.items():
        for pos in positions:
            word_positions.append((pos, word))
    word_positions.sort()
    return " ".join(word for _, word in word_positions)


class OpenAlexAPI:
    """OpenAlex API interface — 200M+ academic works, no key required."""

    def __init__(self):
        self.base_url = "https://api.openalex.org"
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Scholar-Skill/1.0 (https://github.com/maha-media/synaps-skills)'
        })

    def _request(self, url: str, params: Dict = None, retries: int = 3) -> Optional[Dict]:
        if params is None:
            params = {}
        for attempt in range(retries):
            try:
                resp = self.session.get(url, params=params, timeout=10)
                if resp.status_code == 429:
                    if attempt < retries - 1:
                        delay = (2 ** attempt) + 1
                        time.sleep(delay)
                        continue
                    print(colors.red("API rate limit exceeded."))
                    return None
                resp.raise_for_status()
                return resp.json()
            except requests.exceptions.RequestException as e:
                if attempt < retries - 1:
                    continue
                print(colors.red(f"Network error after {retries} attempts: {e}"))
                return None
            except json.JSONDecodeError as e:
                print(colors.red(f"API response parsing error: {e}"))
                return None
        return None

    def search(self, query: str, limit: int = 10, year_from: Optional[int] = None,
               year_to: Optional[int] = None, sort_by: str = 'relevance') -> List[Dict]:
        params = {'search': query, 'per_page': str(limit)}

        sort_map = {
            'relevance': 'relevance_score:desc',
            'citations': 'cited_by_count:desc',
            'date': 'publication_date:desc',
        }
        params['sort'] = sort_map.get(sort_by, 'relevance_score:desc')

        if year_from and year_to:
            params['filter'] = f'publication_year:{year_from}-{year_to}'
        elif year_from:
            params['filter'] = f'publication_year:{year_from}-'
        elif year_to:
            params['filter'] = f'publication_year:-{year_to}'

        data = self._request(f"{self.base_url}/works", params)
        if not data:
            return []
        return [self._parse(w) for w in data.get('results', [])]

    def get_paper(self, title_or_doi: str) -> Optional[Dict]:
        if self._is_doi(title_or_doi):
            doi = title_or_doi if title_or_doi.startswith('doi:') else f"doi:{title_or_doi}"
            data = self._request(f"{self.base_url}/works/{doi}")
            return self._parse(data) if data else None

        if title_or_doi.startswith('W') and len(title_or_doi) == 10:
            data = self._request(f"{self.base_url}/works/{title_or_doi}")
            return self._parse(data) if data else None

        results = self.search(f'"{title_or_doi}"', limit=1)
        if not results:
            return None

        openalex_id = results[0].get('openalex_id', '')
        if openalex_id:
            work_id = openalex_id.split('/')[-1]
            data = self._request(f"{self.base_url}/works/{work_id}")
            return self._parse(data) if data else results[0]
        return results[0]

    def _is_doi(self, text: str) -> bool:
        t = text.strip()
        return t.startswith('10.') or t.startswith('doi:10.') or t.startswith('https://doi.org/10.')

    def _parse(self, w: Dict) -> Dict:
        # Authors
        authors = []
        for a in w.get('authorships', []):
            name = a.get('author', {}).get('display_name', 'Unknown')
            insts = [i.get('display_name', '') for i in a.get('institutions', []) if i.get('display_name')]
            authors.append(f"{name} ({', '.join(insts)})" if insts else name)

        # Venue
        venue = ''
        venue_type = ''
        loc = w.get('primary_location') or {}
        src = loc.get('source') or {}
        venue = src.get('display_name', '')
        venue_type = src.get('type', '')

        # Abstract
        abstract = reconstruct_abstract(w.get('abstract_inverted_index', {}))

        # URLs
        url = loc.get('landing_page_url', '')
        pdf_url = loc.get('pdf_url', '')
        if not pdf_url:
            oa = w.get('open_access') or {}
            pdf_url = oa.get('oa_url', '')

        # DOI
        doi = (w.get('doi') or '').replace('https://doi.org/', '')

        # Concepts
        concepts = []
        for c in (w.get('concepts') or [])[:5]:
            name = c.get('display_name', '')
            score = c.get('score', 0)
            if name and score > 0.5:
                concepts.append(f"{name} ({score:.2f})")

        biblio = w.get('biblio') or {}

        return {
            'openalex_id': w.get('id', ''),
            'title': cleanup_text(w.get('title', 'Unknown Title')),
            'authors': ', '.join(authors) if authors else 'Unknown Authors',
            'year': w.get('publication_year') or 'Unknown',
            'venue': cleanup_text(venue),
            'venue_type': venue_type,
            'type': w.get('type', ''),
            'abstract': cleanup_text(abstract),
            'cited_by': w.get('cited_by_count', 0),
            'url': url,
            'pdf_url': pdf_url,
            'doi': doi,
            'concepts': concepts,
            'volume': biblio.get('volume', ''),
            'issue': biblio.get('issue', ''),
            'first_page': biblio.get('first_page', ''),
            'last_page': biblio.get('last_page', ''),
            'publication_date': w.get('publication_date', ''),
        }

    def bibtex(self, paper: Dict) -> str:
        authors = paper.get('authors', 'Unknown')
        first_author = 'Unknown'
        if authors and authors != 'Unknown Authors':
            fa = authors.split(',')[0].strip()
            if '(' in fa:
                fa = fa.split('(')[0].strip()
            first_author = fa.split()[-1] if fa.split() else 'Unknown'

        year = paper.get('year', 'Unknown')
        title_words = paper.get('title', '').split()[:2]
        title_part = ''.join(w.capitalize() for w in title_words if w.isalpha())
        key = re.sub(r'[^\w]', '', f"{first_author}{year}{title_part}")

        venue = (paper.get('venue') or '').lower()
        vtype = (paper.get('venue_type') or '').lower()
        ptype = (paper.get('type') or '').lower()

        if 'preprint' in ptype:
            entry_type = 'misc'
        elif any(w in venue for w in ['conference', 'workshop', 'proceedings', 'symposium']) or 'conference' in vtype:
            entry_type = 'inproceedings'
        else:
            entry_type = 'article'

        # Clean authors for BibTeX (remove institution info)
        authors_clean = paper.get('authors', 'Unknown Authors')
        if '(' in authors_clean:
            parts = authors_clean.split(',')
            clean = [p.split('(')[0].strip() if '(' in p else p.strip() for p in parts]
            authors_clean = ' and '.join(clean)

        lines = [f"@{entry_type}{{{key},"]
        lines.append(f"  title={{{paper.get('title', 'Unknown Title')}}},")
        lines.append(f"  author={{{authors_clean}}},")
        lines.append(f"  year={{{year}}},")

        if paper.get('venue'):
            field = 'booktitle' if entry_type == 'inproceedings' else 'journal'
            lines.append(f"  {field}={{{paper['venue']}}},")
        if paper.get('volume'):
            lines.append(f"  volume={{{paper['volume']}}},")
        if paper.get('issue'):
            lines.append(f"  number={{{paper['issue']}}},")
        if paper.get('first_page') and paper.get('last_page'):
            lines.append(f"  pages={{{paper['first_page']}--{paper['last_page']}}},")
        elif paper.get('first_page'):
            lines.append(f"  pages={{{paper['first_page']}}},")
        if paper.get('doi'):
            lines.append(f"  doi={{{paper['doi']}}},")
        if paper.get('url'):
            lines.append(f"  url={{{paper['url']}}},")
        lines.append("}")
        return "\n".join(lines) + "\n"


def print_results(results: List[Dict], limit: int):
    if not results:
        print(colors.red("No results found."))
        return
    print(f"Found {len(results)} result{'s' if len(results) != 1 else ''}:\n")
    for i, p in enumerate(results[:limit], 1):
        title = f"{p['title']}"
        if p['year'] != 'Unknown':
            title += f" ({p['year']})"
        print(f"{colors.bold(f'[{i}]')} {colors.blue(title)}")
        if p['authors'] != 'Unknown Authors':
            print(f"    {colors.dim('Authors:')} {p['authors']}")
        venue_info = [v for v in [p['venue'], p['type']] if v]
        if venue_info:
            print(f"    {colors.dim('Venue:')} {' / '.join(venue_info)}")
        if p['cited_by'] > 0:
            print(f"    {colors.dim('Cited by:')} {colors.green(str(p['cited_by']))}")
        if p['abstract']:
            print(f"    {colors.dim('Abstract:')} {truncate_text(p['abstract'], 200)}")
        if p['url']:
            print(f"    {colors.dim('URL:')} {p['url']}")
        if p['pdf_url']:
            print(f"    {colors.dim('PDF:')} {p['pdf_url']}")
        print()


def print_details(p: Dict):
    print(colors.bold("Paper Details:"))
    print("=" * 50)
    print(f"{colors.dim('Title:')} {colors.blue(p['title'])}")
    if p['authors'] != 'Unknown Authors':
        print(f"{colors.dim('Authors:')} {p['authors']}")
    if p['year'] != 'Unknown':
        print(f"{colors.dim('Year:')} {p['year']}")
    if p['venue']:
        print(f"{colors.dim('Venue:')} {p['venue']}")
    if p['type']:
        print(f"{colors.dim('Type:')} {p['type']}")
    if p['cited_by'] > 0:
        print(f"{colors.dim('Cited by:')} {colors.green(str(p['cited_by']))}")
    if p.get('doi'):
        print(f"{colors.dim('DOI:')} {p['doi']}")
    if p['abstract']:
        print(f"{colors.dim('Abstract:')}")
        print(p['abstract'])
    if p.get('concepts'):
        print(f"{colors.dim('Concepts:')} {', '.join(p['concepts'])}")
    if p['url']:
        print(f"{colors.dim('URL:')} {p['url']}")
    if p['pdf_url']:
        print(f"{colors.dim('PDF:')} {p['pdf_url']}")


def main():
    parser = argparse.ArgumentParser(
        description='Search OpenAlex for academic research papers',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  scholar.py search "machine learning"
  scholar.py search "neural networks" --limit 5 --year-from 2020
  scholar.py search "nlp transformers" --sort citations
  scholar.py paper "Attention Is All You Need"
  scholar.py cite "10.1038/s41586-021-03819-2"

OpenAlex API: 200M+ works, no API key, 100 req/s rate limit.
        """)

    sub = parser.add_subparsers(dest='command', help='Commands')

    sp = sub.add_parser('search', help='Search for papers')
    sp.add_argument('query', help='Search query')
    sp.add_argument('--limit', type=int, default=10, help='Number of results (default: 10)')
    sp.add_argument('--year-from', type=int, help='Papers from this year onwards')
    sp.add_argument('--year-to', type=int, help='Papers up to this year')
    sp.add_argument('--sort', choices=['relevance', 'citations', 'date'], default='relevance',
                    help='Sort by (default: relevance)')

    pp = sub.add_parser('paper', help='Get paper details')
    pp.add_argument('title_or_doi', help='Paper title or DOI')

    cp = sub.add_parser('cite', help='Get BibTeX citation')
    cp.add_argument('title_or_doi', help='Paper title or DOI')

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        return

    api = OpenAlexAPI()

    try:
        if args.command == 'search':
            if args.year_from and args.year_to and args.year_from > args.year_to:
                print(colors.red("Error: --year-from cannot be later than --year-to"))
                return
            print(f"Searching for: {colors.bold(args.query)}")
            if args.year_from or args.year_to:
                parts = []
                if args.year_from:
                    parts.append(f"from {args.year_from}")
                if args.year_to:
                    parts.append(f"to {args.year_to}")
                print(f"Year filter: {' '.join(parts)}")
            print()
            results = api.search(args.query, args.limit, args.year_from, args.year_to, args.sort)
            print_results(results, args.limit)

        elif args.command == 'paper':
            print(f"Getting details for: {colors.bold(args.title_or_doi)}\n")
            paper = api.get_paper(args.title_or_doi)
            if paper:
                print_details(paper)
            else:
                print(colors.red("Paper not found."))

        elif args.command == 'cite':
            print(f"Getting citation for: {colors.bold(args.title_or_doi)}\n")
            paper = api.get_paper(args.title_or_doi)
            if paper:
                print(colors.green("BibTeX Citation:"))
                print("-" * 20)
                print(api.bibtex(paper))
            else:
                print(colors.red("Paper not found."))

    except KeyboardInterrupt:
        print(colors.yellow("\nInterrupted."))
    except Exception as e:
        print(colors.red(f"Error: {e}"))


if __name__ == '__main__':
    main()
