import { redirect } from 'next/navigation'

/** Legacy customization now maps to the client-safe tone preset surface. */
export default function ChatDesignPage() {
  redirect('/ai-controls')
}
