import { describe, it, expect } from 'vitest'
import { localGuestLunaPlannerProfile } from './guest-query-local-planner-profile'
const admitted={nodeEnv:'test',enabled:'1',experienceScope:'PUBLIC',nativePath:'LEGACY',selected:'fast'}
describe('local planner tier admission',()=>{
 it('is absent by default; explicit control and fast are distinct',()=>{
  expect(localGuestLunaPlannerProfile({...admitted,selected:undefined})).toBeUndefined()
  expect(localGuestLunaPlannerProfile({...admitted,selected:'standard'})).toBe('LOCAL_LUNA_STANDARD_V1')
  expect(localGuestLunaPlannerProfile(admitted)).toBe('LOCAL_LUNA_FAST_V1')
  expect(localGuestLunaPlannerProfile({...admitted,nodeEnv:'development',nativePath:'DARK'})).toBe('LOCAL_LUNA_FAST_V1')
 })
 it.each([{nodeEnv:'production'},{enabled:undefined},{experienceScope:'STAFF'},{nativePath:'NATIVE'},{nativePath:'NATIVE_MISMATCH'}])('never grants profile for excluded scope %j',other=>{
  expect(localGuestLunaPlannerProfile({...admitted,...other})).toBeUndefined()
 })
 it('rejects an invalid explicit selection inside the admitted local experiment',()=>{
  expect(()=>localGuestLunaPlannerProfile({...admitted,selected:'auto'})).toThrow('Invalid local Luna')
 })
})
