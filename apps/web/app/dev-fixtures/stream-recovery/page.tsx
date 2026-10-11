import { notFound } from 'next/navigation'
import { VenueChatExperience } from '../../../components/VenueChatExperience'
import { TRPCProvider } from '../../../lib/trpc'

/** Real guest controller and transport; browser QA supplies synthetic network responses. */
export default function StreamRecoveryFixture() {
  if (process.env.NODE_ENV !== 'development') notFound()
  return (
    <TRPCProvider scopeKey="stream-recovery-fixture">
      <VenueChatExperience
        venueSlug="fictional-museum"
        initialVenue={{
          slug: 'fictional-museum',
          venue: {
            id: 'fictional-museum',
            name: 'Fictional Museum',
            description: null,
            category: null,
            guideMode: 'non_location',
            defaultCenterLat: null,
            defaultCenterLng: null,
            aiGuideName: null,
            chatTheme: 'light',
            chatAccentColor: null,
            chatFont: null,
            chatLogoUrl: null,
            chatBannerUrl: null,
          },
        }}
      />
    </TRPCProvider>
  )
}
