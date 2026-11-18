// What Bogen for macOS is as a product: free and open source, like Bogen for Omarchy.
//
// There is nothing to buy, nothing to activate and nothing locked. The whole repository, the Mac app included, is
// licensed under the GNU General Public License, version 3 or later, with the additional permission for exported work
// in LICENSE-EXCEPTION.md.

export const SOURCE_URL = 'https://github.com/marselnenaj/bogen-macos';

export interface ProductTerms {
  model: 'free';
  license: 'GPL-3.0-or-later';
  /** One line for About and Settings. */
  summary: string;
  /** Where the source lives, for About and Settings. */
  source: string;
}

export const TERMS: ProductTerms = {
  model: 'free',
  license: 'GPL-3.0-or-later',
  summary: 'Bogen for macOS is free and open source software under GPL-3.0-or-later.',
  source: `Source code: ${SOURCE_URL}`,
};

/** The app's own licence and what it bundles. */
export const LICENSE_NOTE = 'Bogen is licensed under the GNU General Public License, version 3 or later, with an additional permission for the code it writes into your exports. The app bundles Electron, Chromium, Node.js and other components under their own licenses, listed in Acknowledgements.';
