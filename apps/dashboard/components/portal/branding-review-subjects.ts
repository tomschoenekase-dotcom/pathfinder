/**
 * Review-request subjects for client branding uploads. Kept out of the 'use client' editor module:
 * a server component that reads a value exported from a client module gets an opaque client
 * reference, and dotting into it throws during server render.
 */
export const BRANDING_REVIEW_SUBJECTS = {
  logo: 'New logo for the visitor guide',
  background: 'New background photo for the visitor guide',
} as const
