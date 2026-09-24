"""Actual original synthetic source/Gate/Composer/WLT, never a real venue or send."""
import copy, json, os, socket, unittest
from pathlib import Path
os.environ.setdefault('TORCHIKO_CRM_VAULT', str(Path.home()/'Downloads/AwesomeVault'))
os.environ['TORCHIKO_LOCAL_CRM_REHEARSAL']='1'
import component_bridge as b

class FirstSendComponents(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.o=b.owners()
        sources=cls.o['composer'].source_set(cls.o['correspondence'].SYNTHETIC_CONFIG)
        cls.pins={str(p):b.sha(p.read_bytes()) for p in (sources['pilot'],sources['contacts'])}
    def native(self):
        return {'organization':{'id':'SYN-CRM-FIRSTSEND-ORG-unit','canonicalName':'SYNTHETIC Fixture Museum'},
          'venue':{'id':'SYN-CRM-FIRSTSEND-VENUE-unit','name':'Fixture Museum','city':'Synthetic City','region':'SYN'},
          'contacts':[{'id':'SYN-CRM-FIRSTSEND-CONTACT-unit','normalizedEmail':'fixture@example.invalid','emailReadiness':'VALID','permissionState':'UNKNOWN','archivedAt':None}],
          'sources':[{'id':'SYN-CRM-FIRSTSEND-SOURCE-unit','sourceType':'CRM_SYNTHETIC_COMPONENT_FIXTURE_V1','capturedValue':{'synthetic':True,'fixtureOwnerHashes':self.pins,'SEND_AUTHORIZED':False}}],
          'importRecords':[],'threads':[],'suppression':{'blocked':False,'reasons':[]},'snapshotHash':'a'*64,'asOf':'2026-09-21T22:00:00.000Z'}
    def test_actual_original_preparation_is_explicit_synthetic_and_has_no_authority(self):
        out=b.run({'action':'prepare','native':self.native()})
        self.assertTrue(out['gate']['can_prepare'],out)
        self.assertTrue(out['preparation']['writerContext']['synthetic'])
        self.assertFalse(out['SEND_AUTHORIZED'])
        self.assertFalse(out['preparation']['metadata']['SEND_AUTHORIZED'])
        self.assertTrue(out['preparation']['writerContext']['WLT_packet_identity'])
    def test_real_import_or_contact_cannot_enter_synthetic_approval_fixture(self):
        for key in ('contacts','importRecords','organization'):
            n=self.native()
            if key=='contacts':n['contacts'][0]['normalizedEmail']='real@venue.org'
            if key=='importRecords':n['importRecords']=[{'recordKind':'NOT_PROSPECT'}]
            if key=='organization':n['organization']['id']='real-organization'
            with self.subTest(key=key),self.assertRaises(ValueError):b.run({'action':'prepare','native':n})
    def test_changed_fixture_byte_pin_is_rejected_not_refreshed(self):
        n=self.native();n['sources'][0]['capturedValue']=copy.deepcopy(n['sources'][0]['capturedValue'])
        n['sources'][0]['capturedValue']['fixtureOwnerHashes'][next(iter(self.pins))]='f'*64
        with self.assertRaisesRegex(ValueError,'PINS_CHANGED'):b.run({'action':'prepare','native':n})
    def test_suppression_blocks_synthetic_preparation(self):
        n=self.native();n['suppression']={'blocked':True,'reasons':['SYNTHETIC opt-out']}
        self.assertFalse(b.run({'action':'prepare','native':n})['gate']['can_prepare'])

if __name__=='__main__':unittest.main()
