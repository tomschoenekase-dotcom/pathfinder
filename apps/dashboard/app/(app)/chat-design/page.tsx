import { redirect } from 'next/navigation'

/** Legacy customization links now open Look & feel. */
export default function ChatDesignPage() {
  redirect('/look-and-feel')
}
