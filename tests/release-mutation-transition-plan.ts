/** One reviewed old-to-successor mutation identity transition. */
export interface ReleaseMutationSuccessorPlanEntry {
  readonly caseNodeSha256: string;
  readonly logicalProjectionSha256: string;
  readonly newId: string;
  readonly nodeSha256: string;
  readonly oldId: string;
  readonly reason: string;
}

/** One current-only identity inserted after an unchanged historical identity. */
export interface ReleaseMutationNewIdentityPlanEntry {
  readonly afterOldId: string;
  readonly caseNodeSha256: string;
  readonly caseTemplateOldId: string;
  readonly expectedOccurrences: number;
  readonly id: string;
  readonly logicalProjectionSha256: string;
  readonly mode: "all" | "first";
  readonly nodeSha256: string;
  readonly ownerId: string;
  readonly problem: string;
  readonly reason: string;
  readonly role: "dependency" | "root";
  readonly sourceId: string;
  readonly witnessAfter: number;
  readonly witnessBefore: number;
  readonly valueDerivation?: {
    readonly fixtureBinding: string;
    readonly fixturePath: string;
    readonly fixtureProperty: string;
    readonly hashInitializerSha256: string;
    readonly kind: "tainted-release-transaction-sha256";
    readonly taintedInitializerSha256: string;
    readonly transactionPath: string;
  };
}

/** One same-ID source whose exact bytes may change after witness review. */
export interface ReleaseMutationChangedSourcePlanEntry {
  readonly allowedChanges: readonly ["/contentSha256"];
  readonly id: string;
  readonly reason: string;
}

/** One historical source identity removed from the current graph. */
export interface ReleaseMutationRetiredSourcePlanEntry {
  readonly id: string;
  readonly reason: string;
}

/** One current-only source identity and its exact AST declaration binding. */
export interface ReleaseMutationNewSourcePlanEntry {
  readonly binding: string;
  readonly declaration?: string;
  readonly id: string;
  readonly inputProperty?: string;
  readonly kind: "constant" | "file";
  readonly legacyExpression: string;
  readonly path?: string;
  readonly readExpression?: string;
  readonly reason: string;
}

/** One exact current-only `mcpbInputs` companion binding. */
export interface ReleaseMutationCurrentMcpbInputPlanEntry {
  readonly expression: string;
  readonly property: string;
  readonly sourceId: string;
}

const RELEASE_MUTATION_V3_SUCCESSOR_TRANSITIONS = [
  {
    oldId: "release.m219",
    newId: "release.m563",
    reason: "version synchronization now mutates the structural JSON pointer"
  },
  {
    oldId: "release.m232",
    newId: "release.m564",
    reason: "candidate invocation now binds its exact physical line"
  },
  {
    oldId: "release.m247",
    newId: "release.m565",
    reason: "npm pack root became the canonical tarball assignment root"
  },
  {
    oldId: "release.m248",
    newId: "release.m566",
    reason: "npm pack timeout dependency became the tarball basename dependency"
  },
  {
    oldId: "release.m249",
    newId: "release.m567",
    reason: "npm pack lifecycle root became the canonical manifest assignment root"
  },
  {
    oldId: "release.m250",
    newId: "release.m568",
    reason: "npm pack lifecycle dependency became the manifest basename dependency"
  },
  {
    oldId: "release.m251",
    newId: "release.m569",
    reason: "duplicate packing control became artifact receipt command substitution"
  },
  {
    oldId: "release.m252",
    newId: "release.m570",
    reason: "pack manifest control became artifact receipt source SHA binding"
  },
  {
    oldId: "release.m253",
    newId: "release.m571",
    reason: "pack member control became artifact receipt run identity binding"
  },
  {
    oldId: "release.m254",
    newId: "release.m572",
    reason: "reported integrity control became strict receipt integrity parsing"
  },
  {
    oldId: "release.m472",
    newId: "release.m573",
    reason: "Node floor mutation now covers the added package consumer matrix job"
  },
  {
    oldId: "release.m473",
    newId: "release.m574",
    reason: "engine strict mutation now covers the added package consumer matrix job"
  },
  {
    oldId: "release.m508",
    newId: "release.m575",
    reason: "package consumer mutation now scopes its exact multiline command"
  },
  {
    oldId: "release.m520",
    newId: "release.m576",
    reason: "BASH ENV injection now scopes the exact job environment block"
  },
  {
    oldId: "release.m529",
    newId: "release.m577",
    reason: "default shell injection now binds the contents permission boundary"
  },
  {
    oldId: "release.m536",
    newId: "release.m578",
    reason: "early exit mutation now binds the artifact identity guard"
  },
  {
    oldId: "release.m543",
    newId: "release.m579",
    reason: "floating action mutation now scopes the canonical Linux download step"
  },
  {
    oldId: "release.m544",
    newId: "release.m580",
    reason: "digest downgrade mutation now scopes the path and digest pair"
  },
  {
    oldId: "release.m545",
    newId: "release.m581",
    reason: "artifact path mutation now scopes the path and digest pair"
  },
  {
    oldId: "release.m001",
    newId: "release.m628",
    reason: "version placeholder mutation now uses the current exact JSON fragments"
  },
  {
    oldId: "release.m046",
    newId: "release.m629",
    reason: "package-lock placeholder mutation now uses the current exact JSON fragments"
  },
  {
    oldId: "release.m119",
    newId: "release.m630",
    reason: "declarative publish dependency mutation now targets the current needs.verify edge"
  },
  {
    oldId: "release.m120",
    newId: "release.m631",
    reason: "declarative YAML empty-scalar mutation now preserves the current exact quoting bytes"
  },
  {
    oldId: "release.m121",
    newId: "release.m632",
    reason: "declarative workflow-call scalar mutation now targets the current exact YAML bytes"
  },
  {
    oldId: "release.m122",
    newId: "release.m633",
    reason: "declarative workflow-call ref mutation now targets the current exact YAML bytes"
  },
  {
    oldId: "release.m123",
    newId: "release.m634",
    reason: "declarative workflow-call permission mutation now targets the current exact YAML bytes"
  },
  {
    oldId: "release.m124",
    newId: "release.m635",
    reason: "declarative workflow-call secret mutation now targets the current exact YAML bytes"
  },
  {
    oldId: "release.m151",
    newId: "release.m636",
    reason: "declarative npm publish mutation now targets the current defense-in-depth provenance command"
  },
  {
    oldId: "release.m195",
    newId: "release.m637",
    reason: "consumer metadata mutation now uses the current two-occurrence cardinality"
  },
  {
    oldId: "release.m200",
    newId: "release.m638",
    reason: "consumer permission mutation now uses the current four-occurrence cardinality"
  },
  {
    oldId: "release.m228",
    newId: "release.m639",
    reason: "release-check command mutation is now an independently asserted root"
  },
  {
    oldId: "release.m229",
    newId: "release.m640",
    reason: "release-check execution mutation is now an independently asserted root"
  },
  {
    oldId: "release.m230",
    newId: "release.m641",
    reason: "release-check failure mutation now depends on the current execution root"
  },
  {
    oldId: "release.m256",
    newId: "release.m642",
    reason: "npm artifact download mutation now targets the current exact action step"
  },
  {
    oldId: "release.m257",
    newId: "release.m643",
    reason: "npm publish mutation now references the successor publish-command source identity"
  },
  {
    oldId: "release.m258",
    newId: "release.m644",
    reason: "npm channel mutation now uses the current exact shell fragment"
  },
  {
    oldId: "release.m259",
    newId: "release.m645",
    reason: "npm artifact path mutation now uses the current exact shell fragment"
  },
  {
    oldId: "release.m260",
    newId: "release.m646",
    reason: "npm package-integrity mutation now uses the current exact shell fragment"
  },
  {
    oldId: "release.m261",
    newId: "release.m647",
    reason: "npm provenance-integrity mutation now uses the current exact shell fragment"
  },
  {
    oldId: "release.m262",
    newId: "release.m648",
    reason: "npm publish dry-run mutation now targets the current exact command"
  },
  {
    oldId: "release.m263",
    newId: "release.m649",
    reason: "npm publish provenance mutation now references the successor publish-command source identity"
  },
  {
    oldId: "release.m264",
    newId: "release.m650",
    reason: "npm publish access mutation now targets the current exact command"
  },
  {
    oldId: "release.m265",
    newId: "release.m651",
    reason: "npm publish tag mutation now references the successor publish-command source identity"
  },
  {
    oldId: "release.m270",
    newId: "release.m652",
    reason: "npm publication receipt mutation now uses the current exact shell fragments"
  },
  {
    oldId: "release.m271",
    newId: "release.m653",
    reason: "npm publication receipt guard now uses the current exact shell fragments"
  },
  {
    oldId: "release.m289",
    newId: "release.m654",
    reason: "registry publication mutation now targets the current exact command"
  },
  {
    oldId: "release.m291",
    newId: "release.m655",
    reason: "registry publication guard now targets the current exact command"
  },
  {
    oldId: "release.m290",
    newId: "release.m694",
    reason: "registry publication retry root now references the successor guard identity"
  },
  {
    oldId: "release.m294",
    newId: "release.m656",
    reason: "registry receipt mutation now uses the current exact shell fragments"
  },
  {
    oldId: "release.m295",
    newId: "release.m657",
    reason: "registry receipt channel mutation now uses the current exact shell fragments"
  },
  {
    oldId: "release.m296",
    newId: "release.m658",
    reason: "registry receipt version mutation now uses the current exact shell fragments"
  },
  {
    oldId: "release.m297",
    newId: "release.m659",
    reason: "registry receipt digest mutation now uses the current exact shell fragments"
  },
  {
    oldId: "release.m298",
    newId: "release.m660",
    reason: "registry receipt integrity mutation now uses the current exact shell fragments"
  },
  {
    oldId: "release.m352",
    newId: "release.m661",
    reason: "release visibility mutation now uses the current eleven-occurrence cardinality"
  },
  {
    oldId: "release.m354",
    newId: "release.m662",
    reason: "release visibility polling mutation now uses the current exact command fragments"
  },
  {
    oldId: "release.m355",
    newId: "release.m663",
    reason: "release visibility polling guard now uses the current exact command fragments"
  },
  {
    oldId: "release.m356",
    newId: "release.m664",
    reason: "release visibility polling timeout now uses the current exact command fragments"
  },
  {
    oldId: "release.m357",
    newId: "release.m665",
    reason: "release visibility success mutation now uses the current exact command fragments"
  },
  {
    oldId: "release.m358",
    newId: "release.m666",
    reason: "release visibility failure mutation now uses the current exact command fragments"
  },
  {
    oldId: "release.m359",
    newId: "release.m667",
    reason: "release visibility wait mutation now uses the current fifteen-occurrence cardinality"
  },
  {
    oldId: "release.m361",
    newId: "release.m668",
    reason: "release visibility attempt mutation now uses the current exact expression bytes"
  },
  {
    oldId: "release.m362",
    newId: "release.m669",
    reason: "release visibility condition mutation now uses the current three-occurrence cardinality"
  },
  {
    oldId: "release.m363",
    newId: "release.m670",
    reason: "release visibility sleep mutation now uses the current three-occurrence cardinality"
  },
  {
    oldId: "release.m364",
    newId: "release.m671",
    reason: "release visibility counter mutation now uses the current three-occurrence cardinality"
  },
  {
    oldId: "release.m365",
    newId: "release.m672",
    reason: "release visibility status mutation now uses the current four-occurrence cardinality"
  },
  {
    oldId: "release.m367",
    newId: "release.m673",
    reason: "release visibility channel mutation now targets the current exact fragment"
  },
  {
    oldId: "release.m369",
    newId: "release.m674",
    reason: "release visibility timeout mutation now uses the current exact command fragments"
  },
  {
    oldId: "release.m370",
    newId: "release.m675",
    reason: "release visibility terminal guard now uses the current all-mode three-occurrence contract"
  },
  {
    oldId: "release.m383",
    newId: "release.m676",
    reason: "GitHub channel mutation now targets the current exact environment handoff"
  },
  {
    oldId: "release.m384",
    newId: "release.m677",
    reason: "GitHub channel invocation now references the successor create-channel source identity"
  },
  {
    oldId: "release.m386",
    newId: "release.m678",
    reason: "GitHub release visibility mutation now uses the current exact command fragments"
  },
  {
    oldId: "release.m436",
    newId: "release.m679",
    reason: "GitHub release transaction mutation now uses the current fifteen-occurrence cardinality"
  },
  {
    oldId: "release.m437",
    newId: "release.m680",
    reason: "GitHub channel transaction mutation now targets the current exact environment handoff"
  },
  {
    oldId: "release.m438",
    newId: "release.m681",
    reason: "GitHub channel transaction now references the successor create-channel source identity"
  },
  {
    oldId: "release.m477",
    newId: "release.m695",
    reason: "test fail-open mutation now binds the reviewed 20-minute full-suite boundary"
  },
  {
    oldId: "release.m504",
    newId: "release.m684",
    reason: "package consumer command mutation now uses the current exact command fragments"
  }
] as const;

const RELEASE_MUTATION_V3_SUCCESSOR_TARGET_WITNESSES: Readonly<
  Record<
    string,
    {
      readonly caseNodeSha256: string;
      readonly logicalProjectionSha256: string;
      readonly nodeSha256: string;
    }
  >
> = Object.freeze({
  "release.m563": {
    caseNodeSha256: "51bc26b0be01072b7df492b509f631b14ba5393f47132b5b71b35dde6fec4e8f",
    logicalProjectionSha256: "34597a45252300f93fbb7213b46cc61f1ec1b219b4f13c4487cd3fcc21adf800",
    nodeSha256: "90bcb5dfaf721645ba4173b029752d0484aa3b3a8e209b93065ee90d4ee9d829"
  },
  "release.m564": {
    caseNodeSha256: "8eb1d5e3b9fe2727aecbe7154fb96cc13082de5b00ac227bd0781ddd0f1de061",
    logicalProjectionSha256: "45a874270298911dc4299e36b88435b713098ec197e7bced04ef5892f2a744c5",
    nodeSha256: "d9234981f583c4ad35646abd081bb685c21ef2c93b2a39d5b9a144c5c15a62eb"
  },
  "release.m565": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "be1addfaea7b23ddce0dd4fbbbba4b0aded4efa64282695460bc6ee48c3874b7",
    nodeSha256: "342b965bfefb845700fbcf6e4afd6459f4b631855ea05c7a9f2436cc3fb930c9"
  },
  "release.m566": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "e4e43a461fe87eea0d00269f0307045738f1eb3026ff0739445979629074afcd",
    nodeSha256: "9012ae5f1e680653e43365d77a8501cef766aeb57ba15fab9722fd1b68a2b509"
  },
  "release.m567": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "349cef088f45e1475c32cf5cd48b962dddf6c7fa442f1df7509772efdcfdd9c9",
    nodeSha256: "3908a6d4e74671bf548fdfd6fe54071ef723f73fa7f9a529daa234f33eab7490"
  },
  "release.m568": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "c619f84f9fb49b4ee6cd058359f557014f52c513c58f9b6ec1b5e52aec900871",
    nodeSha256: "d129bcbf55d77b27c8e23cc239b0f1ff0d169b452fb4d400afc4378447e7921c"
  },
  "release.m569": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "b9f573275ce9792e33fac003133bd3f901f41eda0f564a951638278642f7c583",
    nodeSha256: "c1d4efa726a79043e2dc423295db841dbe20158b98a1e1792b28050a53c0d1da"
  },
  "release.m570": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "e08848d202e48991bffce210261489bd236ce914098247501affa7a46b88025b",
    nodeSha256: "e61a4271506d707c6fb88b5610773a9d3e0c0eb58c025d695aaf21592d6b2433"
  },
  "release.m571": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "e1fdafedcc3a5cea1347cc3520e3e124fb891e9b947c572274914d18fdfe2a6a",
    nodeSha256: "3141660e7428fb009515fd1150e780b91b5a2e4c4bfeaff9183fa3520ef2eb4b"
  },
  "release.m572": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "930ae3e0061cd790d7c6b14d342085ad00d6f734f3af05972fbd23dd2308a654",
    nodeSha256: "eadc4a3bb25336e474fcbf5578169a14c3591c53c8e9e0c9ea04d3da4d38a36e"
  },
  "release.m573": {
    caseNodeSha256: "25e0f175a9edd0010ff37d6e336d6311edd649dae86ca02b0a57c710be925090",
    logicalProjectionSha256: "ce282eb8cbdb494a76c81f68c766019c1116a71a8b2fdb1c4899ec683056ce66",
    nodeSha256: "83a32557f7af8928a3e4c2a51ed1b49298edab03223f3568c3fb63bbfaaa3a09"
  },
  "release.m574": {
    caseNodeSha256: "f60ac08e142f4d7c80780da1bf14b2bcb3f26b4f90d9d2c0a37921bb33c90239",
    logicalProjectionSha256: "8c529f125baf15a7d371838914b1abed6a24fb0eee312e097433b1d5aee26576",
    nodeSha256: "df3c2d8b5f468ca04de6adaaf9b34c38a028b2999ef71f15f1e3565a7fdbb8cf"
  },
  "release.m575": {
    caseNodeSha256: "0294ab432dbba7eb5407bb4da1105c9168b213daab90742a3be30aa60fd99db8",
    logicalProjectionSha256: "8d39c6efa46c0574fc803a8debdfaa6fe1789db3796a98034d58bcfa5a9c3177",
    nodeSha256: "3a8320201759bec9f516c397dfc1d4ac865c89ce899fbe18c287f39466892bd3"
  },
  "release.m576": {
    caseNodeSha256: "d9801c531ea6546ba603760323b940bae9ae2f61628d39870b6c27cfbf15f0c4",
    logicalProjectionSha256: "ffe76e959b32e0a56b6c3b667a74c32981ed8b4af4914fda8aeb14a24a5322ea",
    nodeSha256: "de6c391b2be6daa1e7db645e8c3033784ed868a021d595b2a5025cae3bb74122"
  },
  "release.m577": {
    caseNodeSha256: "40e758f5a1f012fbb1363160cf782334f275b3464761798c0b225afb5a556252",
    logicalProjectionSha256: "55c8247c40dde352fe9d941d14df537c597bdf75d2d5d5609d86bedf831aa3b3",
    nodeSha256: "3c7bcc3d2029e08ed93f399c84d3625817f1d923311f179f7a78e41075868310"
  },
  "release.m578": {
    caseNodeSha256: "4d768a6fe9bddb399267a58a80979778b7c644946d48eddc7bb00b195ef2d61b",
    logicalProjectionSha256: "c18ab849d739aa71686378287e34d9af636627a714086ee25deb4d4776a28a15",
    nodeSha256: "e1b05e91d53c9888fd0c898113f0e978aeb7a5043fb7b04eb915432b04720339"
  },
  "release.m579": {
    caseNodeSha256: "5d51acaa480a048f2147d33c09ff81ec0f96ebf4637f381e5face55fe3eeb62e",
    logicalProjectionSha256: "99d2f30f968bc03aebc54997efdc698a51e1d70b7e39513c693f446f179581a5",
    nodeSha256: "3f0f4bf5cedb6f60ba85a8d70ad4d2b3cf67303d6865d0d080d614c3b40f9fe7"
  },
  "release.m580": {
    caseNodeSha256: "e9d3b33dee1b8bd404c5f51e77bda4204f0fd21d6487efb44c4ce743f64de1a0",
    logicalProjectionSha256: "bf3e3d77ef3e5be43b79227ea3f3317f0fea9ea52c8343a87cf6e153fb4183c8",
    nodeSha256: "def78ef2e6ce1cc8eb746fdc796c8f21d0285baa71ab7863f9ccc59629992c3e"
  },
  "release.m581": {
    caseNodeSha256: "ff39b3433d3b30461a0a893d58eeb15b94223102949a4abe6c5615910c4dcf65",
    logicalProjectionSha256: "cefa5cd27d2032c65d0016b9ae5479685ecd0e2813d67584dbc155818f246683",
    nodeSha256: "ab3c0cc7209bb84effdae99c271197f14da87ce6cd71a31e7a88e563bb0537d6"
  },
  "release.m628": {
    caseNodeSha256: "5215571f1d919526e7b8d0975b35dba36be39987518bb9320f5ebfc2b5f01b28",
    logicalProjectionSha256: "861d0bb8b69589168fc7858391be4db2dcb7b5b4bd91a2d9bc30ef44b34b480e",
    nodeSha256: "4be8ed6d70faf99374f9d4e0dfccb7b3a9714b82ecee87ef9c3fef744505782e"
  },
  "release.m629": {
    caseNodeSha256: "5e2815d5e91972642e0cdafbaab958423ce7403d42923787ef09ba6cb4377f45",
    logicalProjectionSha256: "2fc5950d515d81e1918aaf3dab8b3ac2ffe5658406849c72e9f771bf126a7f55",
    nodeSha256: "5625de67f9e568231d6fc6cf4a22522294bb491fbe0af0f4323206e715e9be44"
  },
  "release.m630": {
    caseNodeSha256: "e9231b33837f34921838cb2f305e1b4521fc637300bfdc927ca1acf131c9f636",
    logicalProjectionSha256: "9bd93a2c31190913ec7f0bafae5d751b2e35d8e06cb6e98a823c07412ec50876",
    nodeSha256: "10369bef22d56279206e13741f005160975c1af21aa78784b1a7b386ba848de6"
  },
  "release.m631": {
    caseNodeSha256: "57c354674605febcb0de8461342af9231b2411f2427971e8e2606b9d6e1798a6",
    logicalProjectionSha256: "6d40912afd47597e3f90895e03a7352238d6c13b406bda41c79380e7ce7865df",
    nodeSha256: "7e5df55d2870651b98133baf0489e45d13782ef096797e3afc6432ae61443307"
  },
  "release.m632": {
    caseNodeSha256: "bc495e21980f731ae6ac77827281df4e8fa5cbdc8bef659d9453faebfbefbd97",
    logicalProjectionSha256: "5a612625e91318ce067007bacf4935721808c2e7212287d2efc36b5a0a7f3e6b",
    nodeSha256: "f2d583fda4d1fc6dcf19587b40d88b416b575e2773db45666e523efa30bccb80"
  },
  "release.m633": {
    caseNodeSha256: "7264667e6c19c8cfc9b6a5286985e89f5ebbe8b74df9653ecdcec5e46fac00ca",
    logicalProjectionSha256: "9d5f09c74d9007a7c2c79f980f7eb1ed9563dddcbae94fcac953ec1b95a96ed2",
    nodeSha256: "a07f83004e30aa83496a88247f8ef55ff9253e92d0658a54bda014df36f97d06"
  },
  "release.m634": {
    caseNodeSha256: "30cb81660c543d3568a488aafc9587b007116a23cf35788c5141f044e606baf5",
    logicalProjectionSha256: "b14c96dcf4e85f88e72cc2a50d7ecce69354c0cdab57a9c17d4743d7520c8748",
    nodeSha256: "dd3966793b850c3d4cbb910137e0d58de85994e5b6d34908cd73af14b010709e"
  },
  "release.m635": {
    caseNodeSha256: "6ad7ab5b2081317729eed3799f1ba8d4b4dad08edd7285d58e5da9877a34e061",
    logicalProjectionSha256: "3e78cc25521abb0779969ac252e8648e45ff3eda41824d23163aea29f1fc8ca7",
    nodeSha256: "02e3922a980675247c25ba15bbc3d528197c170e4b5411c6b257cb553357d8bf"
  },
  "release.m636": {
    caseNodeSha256: "d3c6663b9c931b550fc19e2d4fc5469aa4a0bf3b7c4505bc2f9863b65c957e7e",
    logicalProjectionSha256: "24dce8212daffd440273f484b3922d4a8091c193b45bb06150b6e5a266c289ea",
    nodeSha256: "6814594422e7598522284c1380cf1bca6a01d41adc85dea7eba413ac4daa5322"
  },
  "release.m637": {
    caseNodeSha256: "8aa90566db78de2e50afd6c923a19c11e991de5953e86753e17f43b68b6061b5",
    logicalProjectionSha256: "3400bad35e1a6149faf333703462ced201ae91fa217a7e36adeaa8d704dd05ca",
    nodeSha256: "d8eaf4ed78f2e04f0f458b3f9fb6a51f994c930df9524bd3b12f4e872259080c"
  },
  "release.m638": {
    caseNodeSha256: "c1dfde5054344c39fd1d08574ec26bd39f1d1f3783bc820a5ca976d9a3be8869",
    logicalProjectionSha256: "017e1a0c6a7d123b71bdc48692a9764da5175079e7441010182b0cc7b4225d93",
    nodeSha256: "14911fa24e50a9dc9fffddf15393aff30d481edb595909f2bb445b0ef90bfeab"
  },
  "release.m639": {
    caseNodeSha256: "0ac902dc43ac8ae17b94684e1d572f98c129eeaeb1119ba6c5ba620143b7661f",
    logicalProjectionSha256: "522a093d32901dbaa5fc5bea64c9edbc78f02f160f49a4f4a7ed21bc40ffe966",
    nodeSha256: "f183919891448f758911903ce98b2b8e55ea2a979c02138d9d7ea807751ce247"
  },
  "release.m640": {
    caseNodeSha256: "0ac902dc43ac8ae17b94684e1d572f98c129eeaeb1119ba6c5ba620143b7661f",
    logicalProjectionSha256: "e0b6fff211030ea2f964ec1d0a0b3a00ad04325ae90123c3f78c83cad0b0990d",
    nodeSha256: "dbc9129756f743314bac59dbafeb426223bac0792f6e1b8a7f6179481ab4c85e"
  },
  "release.m641": {
    caseNodeSha256: "0ac902dc43ac8ae17b94684e1d572f98c129eeaeb1119ba6c5ba620143b7661f",
    logicalProjectionSha256: "ccbcec5c0c22ead1791f7d08cefc35a552a3d9ee118bbd9b4da46b47b3d5dc0e",
    nodeSha256: "819c12aa04a32d98aa36562f0442331aaeb080c013ac164487654da65c6ce2be"
  },
  "release.m642": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "458fd5f80df5864970d259837b1693bc7e80e5cee102a8a18c095ba97ca5a6e9",
    nodeSha256: "406f2e46223e4f28820944c44809a9d52ca26722af8c57f94020696c1ec7c970"
  },
  "release.m643": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "6d08e271e75528e91cdfdb3ab78edd219b8fcb8b578d611eabe0a36c2436e83c",
    nodeSha256: "e52378a9d148ca30f5002e44fc1f4589f4bd568cd7ab73d317600409e7f5b3a0"
  },
  "release.m644": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "5620d0a4afdf7d770da4ecc4b4a7b433535a10af282bac801d095598f5726901",
    nodeSha256: "27f47fdbc9f10b87a15944b517bf4dbc65d6981c859bc686f271dcbf69aac018"
  },
  "release.m645": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "99539849fdf2124b58dcc6ec4d6f42b8ee608b7764dee1ad7a31603acf77ffa9",
    nodeSha256: "4e8b3d0b81514c46e90e3b669e047409255f5ddf639aa1de2a28379d4dbca6e6"
  },
  "release.m646": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "b3bb4522dced7a60d60f9530d4b01ab9244f772ac9547b463ef2c4f58a04b6c7",
    nodeSha256: "c8aa35dfab1c9378f99979dbe6400ca0aad00e7889f1bd4b97150077a0a4f0cb"
  },
  "release.m647": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "207baa78151a5966fa25a23f2e51706f924a3fb9f07a0be65870faa75cba03a5",
    nodeSha256: "b521fa18c98093ac4da74e7f0885be079a64dc5fbff8c1ccf39a7004c8bf948a"
  },
  "release.m648": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "be3d3c01e3fa86b93abdd31a1a528bbc20bd7649ec3bbb089ce9f8dc9fd838b6",
    nodeSha256: "b9327e66bf994a3e3549f5039f5777613d7c41227ce617f637ec1fcb8268c3f0"
  },
  "release.m649": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "35dc56739207498caf518adb37ca3533b7db86d6b00a6f5f1875f548c268a3a0",
    nodeSha256: "86c6cca91569eabdabf9126ab155310adb5b39c578658bd4156b26e7455762ac"
  },
  "release.m650": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "b1fbc6a2cc8662434ce2852a0846dcab26a8a8c8a4370de97754aa194c509986",
    nodeSha256: "99021e4be1fe692eae7ac9b4091531b10e5206e02fc7ba472f108e83ac723f58"
  },
  "release.m651": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "2f5eb8fda51c7221a6bdb756138484b26947b3c44856577e61ddd8c4ffccf796",
    nodeSha256: "157c035221e23c9f789c1462923b21377ba97c18720201411df278add4b1d593"
  },
  "release.m652": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "c20c094a7a3986dbb14c04d7789a89e4f5b79033fded1f3b3a9b532583fa041f",
    nodeSha256: "42c5f504daf32e9c8596fc6cccc57b3c521fe13c0c3c4b45eb697aaf4bcf7062"
  },
  "release.m653": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "24e899feb51616288f16f1f5e0e418dde621c862be6acfd1e0f4a14a04d35539",
    nodeSha256: "f994cb4fe99a6a611cfab2a4bbfb9c44a31d66c0eee20ffcc617dc031e01fd14"
  },
  "release.m654": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "a7af63e27e4b02cb95cac3af1cf18ba86655b10fa02563b0a8f2eb165d638906",
    nodeSha256: "4bf48715821b8d64da1e05b4225cd30f007b4c2cedcfba13ef9b91668707390b"
  },
  "release.m655": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "c7212be22f7f95d656363fc345c6dad384ada2cec74b1c7899ef62830bd61c37",
    nodeSha256: "4bf48715821b8d64da1e05b4225cd30f007b4c2cedcfba13ef9b91668707390b"
  },
  "release.m694": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "d270076c2e8fc0ce6807a7e9cec3c6b676ceb4174193385a7998d4b6ed1dbffc",
    nodeSha256: "91c08ffe19bcc0e54c42116a7a3a6e2413589f47da9641870a9d49550a7f2de1"
  },
  "release.m695": {
    caseNodeSha256: "55ad31f20f9b6b1a18c2193945fb7bb6107b7bf97cab9d75982577cb3070f157",
    logicalProjectionSha256: "ff1b993fee0b871200aafb062ac70c7a4e13da3b2645458754996f3730b5eb2b",
    nodeSha256: "e091817974adf13d0d68a00e2e3584d6b2e4b9e44e56435a628604c85e8125a9"
  },
  "release.m656": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "9fe221c41c233679cb61a7bc09f2b8a822f6f80332dfcc9f93d0c255c19609f4",
    nodeSha256: "e5d8247b36480ebda7ae9f1aeb247715d38873c6e841b9423962d572424fabeb"
  },
  "release.m657": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "a1777b9a6c7d436bd31ba1619558ca618c1d23119c19104819ce31f42527d4f7",
    nodeSha256: "f5ebb645481f50ab351c2bd38ff54ee286aa8edba5c09078a0234b491f8ae259"
  },
  "release.m658": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "3f6cf779ca0e1640b1fc536eaea982dcb137aa98680c3c6f0a45f214e822695f",
    nodeSha256: "7ef853678b97436dde8b5b40f2562e09febac7d1b047f3b5f859aad3242d569f"
  },
  "release.m659": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "ac847041d92250a4881f9ef03e1c475886dc23a8d73f60cf1d6a278d41ef6edf",
    nodeSha256: "eb1136087c6d751281a358ad5fe54749e607be21a970fcfaff8061e9fc15c409"
  },
  "release.m660": {
    caseNodeSha256: "392e6a79c144cbfa6358a8d607ec300fb91ac2a5b1b34a2f33f065eb25066ea1",
    logicalProjectionSha256: "a85dcdb43634c7627fdd629321fda4fae37e82930c504ddeff11e8279e6c5ac7",
    nodeSha256: "33acad4aa5de2061977ecd2f4fd8ed986387b19641f7d005631c5e1537c149f9"
  },
  "release.m661": {
    caseNodeSha256: "df5a00757215359cc873505fc976de42141e1f27f55622b906f6a346203d6c4f",
    logicalProjectionSha256: "e97fce37b36ec560c5e59d2a55cabe6237b9193b7b8b899257b63f71f16ba060",
    nodeSha256: "6f5c2094ab7f730f0630bf780a00993ad0830f54463c18c322e578cfaf7ff3ff"
  },
  "release.m662": {
    caseNodeSha256: "df5a00757215359cc873505fc976de42141e1f27f55622b906f6a346203d6c4f",
    logicalProjectionSha256: "c079db9f22c2b375bd718dfc24b0d2c5740cc1d090942d990229aaf6ad9600d6",
    nodeSha256: "b1ec1b3f8761a1d9aaa15077fdfa117ea26240d2247b60cb2cec90e9ddb4a9bd"
  },
  "release.m663": {
    caseNodeSha256: "df5a00757215359cc873505fc976de42141e1f27f55622b906f6a346203d6c4f",
    logicalProjectionSha256: "2669f7347e47c44fb3fcd2fbc9a5a9ba84a53bbcb970965210890e47c35b58f7",
    nodeSha256: "6947cfb2bf6ed584fcd40e73d0f1d7df13e1294c4a92d6111ac16af1371e2d80"
  },
  "release.m664": {
    caseNodeSha256: "df5a00757215359cc873505fc976de42141e1f27f55622b906f6a346203d6c4f",
    logicalProjectionSha256: "19fa8f0726715c7bcaad57da50136bcdae47d8e25eca738684d9e078e40b8504",
    nodeSha256: "35cc85f24f1bb4fcc56d5c1a9dad6332d73a86a8f84717378f2084070039fe67"
  },
  "release.m665": {
    caseNodeSha256: "df5a00757215359cc873505fc976de42141e1f27f55622b906f6a346203d6c4f",
    logicalProjectionSha256: "91a976a41196ff370d08a46237509f1c02dccf100fb8bb55e11289816fc87825",
    nodeSha256: "089986c1d42bd961aed138f567a42726b564d745ea976c0e5b5480cb7b61b08d"
  },
  "release.m666": {
    caseNodeSha256: "df5a00757215359cc873505fc976de42141e1f27f55622b906f6a346203d6c4f",
    logicalProjectionSha256: "54d81d8e7964efd86965f0831ec8ab846ca590264358a72747a9f049d577c38a",
    nodeSha256: "b5b0ec694663b025c288c49c8254f5ec9abd9f8ac24d05225e6842aa0317b6da"
  },
  "release.m667": {
    caseNodeSha256: "df5a00757215359cc873505fc976de42141e1f27f55622b906f6a346203d6c4f",
    logicalProjectionSha256: "39ac7cead27d1c8927831f34683718debd0238a48f0d02c6ab30dd33cfb9b62a",
    nodeSha256: "fd23a9714bc5e9d08d94a21e533d17906029f665def08e928b93e254ea67c9ba"
  },
  "release.m668": {
    caseNodeSha256: "df5a00757215359cc873505fc976de42141e1f27f55622b906f6a346203d6c4f",
    logicalProjectionSha256: "5ed7325ba818f5741f425d6c8e6f9642b51e77283a8e1362d349617a4f36aacf",
    nodeSha256: "472534c1ba5abba2c8c7bfaca95f69815e2de51ddf5dd58e573d4128e0befcc5"
  },
  "release.m669": {
    caseNodeSha256: "df5a00757215359cc873505fc976de42141e1f27f55622b906f6a346203d6c4f",
    logicalProjectionSha256: "341766f9dfef8a8729a1590736a04f1fb82ad6169bbe0d45eee1983bf2b017ab",
    nodeSha256: "356e83ce22e095c59ddba333b510e3d708916bee8b4a1146a7f968dcc5a689fb"
  },
  "release.m670": {
    caseNodeSha256: "df5a00757215359cc873505fc976de42141e1f27f55622b906f6a346203d6c4f",
    logicalProjectionSha256: "716ef0215f9dab00b01ef6582adc28f2627b3475032c39266b08cd01513dfcb4",
    nodeSha256: "b47369fb925a8d7dc722d47a908a9c6cc15e428d459fd5114561769841678bd3"
  },
  "release.m671": {
    caseNodeSha256: "df5a00757215359cc873505fc976de42141e1f27f55622b906f6a346203d6c4f",
    logicalProjectionSha256: "93f0ee4a92f4562a89359e6a07d48d59659fee1451e2c18829c5c83c14cbb01d",
    nodeSha256: "5970dee540eb8743bf11cfb8931b20169fbec1f7cae9dcc089f6983bdadd3856"
  },
  "release.m672": {
    caseNodeSha256: "df5a00757215359cc873505fc976de42141e1f27f55622b906f6a346203d6c4f",
    logicalProjectionSha256: "5282abf7a0a669affaacc21cc8a75b687c8b1f28426b4f079720752b01d3a6bb",
    nodeSha256: "2540ff2f17e96103a893f8a52f77e05b5297d5a3797ff2bd8140d78e577c8d9d"
  },
  "release.m673": {
    caseNodeSha256: "df5a00757215359cc873505fc976de42141e1f27f55622b906f6a346203d6c4f",
    logicalProjectionSha256: "7071f7d195243e27cfc99370c8c46a4c59c0d992403f91a455afec7678e4ad92",
    nodeSha256: "d21ec8fa3dac6f245375e90341c8e7eb28b17291e8dbd56d5045e8ab15709a51"
  },
  "release.m674": {
    caseNodeSha256: "df5a00757215359cc873505fc976de42141e1f27f55622b906f6a346203d6c4f",
    logicalProjectionSha256: "fd4e25587d29b55d6e53629dd96204db5bf43dfbaa315230f73192d60805ea31",
    nodeSha256: "96d69b1ab8f78ee301588c7e64c5eccd850529a30f86064a71b11398511d8c29"
  },
  "release.m675": {
    caseNodeSha256: "df5a00757215359cc873505fc976de42141e1f27f55622b906f6a346203d6c4f",
    logicalProjectionSha256: "5e383cf489185678a4595e309d73730dc8df86eaad0136ed9ba3acc322971f00",
    nodeSha256: "9353b4ad3831ab8c49dc7ac6b1b5b73f02c216e7df470f483fec1d90f8f3ecda"
  },
  "release.m676": {
    caseNodeSha256: "df5a00757215359cc873505fc976de42141e1f27f55622b906f6a346203d6c4f",
    logicalProjectionSha256: "92a34d2f2264a6e5f52626a54f3a8630136af1d55b57f45a855965dd77a99072",
    nodeSha256: "c94dc9e8338ab2eaeb1ea709ac2c0f71ce8ebe465605bde76b19ec491efd6dc0"
  },
  "release.m677": {
    caseNodeSha256: "df5a00757215359cc873505fc976de42141e1f27f55622b906f6a346203d6c4f",
    logicalProjectionSha256: "7c215957e1e4113564e5e58cdf3eb3fac5968d9cad255441decc9552b4e05157",
    nodeSha256: "a0cd56d83848a9e4b47e9c19740d88e018815dbfb63ad326aab99a007655e53e"
  },
  "release.m678": {
    caseNodeSha256: "df5a00757215359cc873505fc976de42141e1f27f55622b906f6a346203d6c4f",
    logicalProjectionSha256: "eba61dbce5b72a7cb18e5a55f74b5e2f7753ddb372fb32df17aac84c13b08000",
    nodeSha256: "9d21c40c634ac52f60224e2017bfa451105430c15b8319f873d4609b4fe87f1b"
  },
  "release.m679": {
    caseNodeSha256: "a46e159b0101b43a177f97b61c51d64886b719ca0d2f1e7831a56c3c6d8820a7",
    logicalProjectionSha256: "afe37adcb5be243526ade68e99c45a778c301a9bae1ef50e382305059c6ff39d",
    nodeSha256: "fd23a9714bc5e9d08d94a21e533d17906029f665def08e928b93e254ea67c9ba"
  },
  "release.m680": {
    caseNodeSha256: "2cc37825d3042c21ecde4bcb70fd536dd83e1b088674f6b72961a193c4c06b02",
    logicalProjectionSha256: "b08dd150f7a106745a700d1d4de2e1a27026fe8eb7228d8de88f0bd104a78f40",
    nodeSha256: "c94dc9e8338ab2eaeb1ea709ac2c0f71ce8ebe465605bde76b19ec491efd6dc0"
  },
  "release.m681": {
    caseNodeSha256: "2cc37825d3042c21ecde4bcb70fd536dd83e1b088674f6b72961a193c4c06b02",
    logicalProjectionSha256: "e52ef867e52183b3fc8f5cfb2c915afc5caf9217f58e5779d729abff61a22b98",
    nodeSha256: "a0cd56d83848a9e4b47e9c19740d88e018815dbfb63ad326aab99a007655e53e"
  },
  "release.m684": {
    caseNodeSha256: "6542d5f5cd593a3ce8ee032d340fcb9fcbd6f7d2169b7b0bffdf62af4e30c13f",
    logicalProjectionSha256: "c26faab5f9a07d5f831d7effb6d2d46a066d950b9db32b36e5265674ddf5a6c4",
    nodeSha256: "b2b4a39da20aa6a580f3fdf0531f1524f8855120985d69404291f2ec0317feff"
  }
});

/** Reviewed successor map; all schema-v2 IDs remain permanently reserved. */
export const RELEASE_MUTATION_V3_SUCCESSORS: readonly ReleaseMutationSuccessorPlanEntry[] = Object.freeze(
  RELEASE_MUTATION_V3_SUCCESSOR_TRANSITIONS.map((entry) => {
    const witness = RELEASE_MUTATION_V3_SUCCESSOR_TARGET_WITNESSES[entry.newId];
    if (witness === undefined) throw new Error(`missing reviewed successor target witness for ${entry.newId}`);
    return { ...entry, ...witness };
  })
);

const RELEASE_MUTATION_V3_SUCCESSOR_OLD_ID_SET = new Set(RELEASE_MUTATION_V3_SUCCESSORS.map((entry) => entry.oldId));

/** Exhaustive 484-entry old-ID class whose logical projections must remain exactly equal. */
export const RELEASE_MUTATION_V3_UNCHANGED_OLD_IDS: readonly string[] = Object.freeze(
  Array.from({ length: 560 }, (_, index) => `release.m${String(index + 1).padStart(3, "0")}`).filter(
    (id) => !RELEASE_MUTATION_V3_SUCCESSOR_OLD_ID_SET.has(id)
  )
);

const SPLIT_RELEASE_CONTRACT_PROBLEM =
  "split release jobs must preserve exact handoff, authority, publication, and stable-only registry semantics";
const SPLIT_RELEASE_LOGICAL_PROJECTION_SHA256: Readonly<Record<string, string>> = Object.freeze({
  "release.m582": "63393625e93899cec93acdc18a9acaddf64910c66c39aa856bbe42b03c3059b1",
  "release.m583": "ddda4ad2a8eb8afef26a285dcf59a626433256e92dd2bf489f8458f74245ffc5",
  "release.m584": "8f5005b1e10ffaa507be24f2221269659ac3b78008c45109a9c0673552c21020",
  "release.m585": "bc31c3f01726617d53ec3fef5ea7afde4c9009612c553e1c1df47bcf5a717e7a",
  "release.m586": "500c64da915248b7055013603a603b511cfd51c4a666a06b8d03503232e52622",
  "release.m587": "21212eac5719c5c9452eb445df07ab832ab0351834e50be73a603b409011e3b9",
  "release.m588": "e6ed5cc712f83d1f2c02bc4ec5b74172cee13415f308df05c2b302a2fd5b7858",
  "release.m589": "2a9e4a52986d89ee667bb72c50635623ad9f333cd75e564f79b9ec93f956a399",
  "release.m590": "fe02884f92287a61754bc16f29a56ee4a83fe030aef4e746e4bc647b4efabc93",
  "release.m591": "7e2c2dda1a3ade333fa4e17d65b50cfd201dd9dc06e106de87395dbf7e418cf3",
  "release.m592": "f51060955f743fcb81541c0ea7d44333bde72740cc6920f9d4541489617cba75",
  "release.m593": "e7071fa980abadb5ab3535cd14ba0a61f27f5650be02aa1e3149fc419ab50e63",
  "release.m594": "dae5018160cabab7dbef7c67afefa0db1bb6c7ce5d174011879f003d01e9d2fb",
  "release.m595": "eef9770fe170e48049dbc4a4daa8a90c7b99165394c1456ade551fc564dd4d58",
  "release.m596": "1ec14f45fe091fb042c8e4ad79f6298253792210a1f671f18170ec5aa41e6bf3",
  "release.m597": "6456852131aa57d6336ca1cd47c4513972da7e7c649ee93ff1a49d4d5f8a24a3",
  "release.m598": "fe4046c00b2936af85e7e7fc6df7a0805f255e65e4c8db6c30c159de73842ebb",
  "release.m599": "1cacb16e63ae597d0630ab4657678c9dccd3b21993925c9d87ab07fedb8632a5",
  "release.m600": "9a368a04115fc9c3155742255bfac2661706f16d42345a9558000aa37dd8e725",
  "release.m601": "64d5b29653c05e19983ab719da8a2caf02339378607243c3cb023731fcfc4ff4",
  "release.m602": "caffde55dae4b08f7470273584ea20929675c98ba6c0f036b6c0030331b9f3cc",
  "release.m603": "a21b410eb9dfb07c2ec753d7e03c92e1f6cd9c3d64e71fd8954dedabfb041b35",
  "release.m604": "95487a0cfd6a19ed74fafb8677635747aadddd6e0fb9d38899dc06e734f432f9",
  "release.m605": "a2e087c2cf2e22625f0b859b1622f5862752b75213e00e133dcf8e874f8cf262",
  "release.m606": "84de88997aa3aa516aac67f546215306c5a8c9254608b4d82c3ef30670616a10",
  "release.m607": "e03b58ac0268e64ab08f7db7087c07fa63557d2426ac3011b0935cb34d0e74c7",
  "release.m608": "19c0be8c379cadccc5e3200f23a621025e21970f678501a25f22321368f96e55",
  "release.m609": "ddd437d44d3b6bd6c5fcc11624b42ac7e78d1b54584da272140e2dc4292d8aa0",
  "release.m610": "65f29f730f6942b10d2e195478be476fb9d231cd2ef41bfd908da7efa8cf14f7",
  "release.m611": "772b6b5e00416059904d7edd659e3e1986ecbd22ef7604ce2d8a8c0c19cd1147",
  "release.m612": "4a33fa8abdb92a6459dab1ff9c20d93867fc7afee9629c2851daadc8f53c8ad5",
  "release.m613": "60cd3673e0da9e8955e9e716a9cfb9da9d8b9ba2caacbae2938dc088c7c8baeb",
  "release.m614": "1761e90c55565a8d5937ebe0e3960c021092a7a32696bbb4d377925154e49fac",
  "release.m615": "ca86c3f2338790c2d05b99b085e1bdd78a444eb9a45241994f3a391d5d516563",
  "release.m616": "8575647f1fe128b704544a08bbcf6e8f372de5609b3425fae30b6775867a088d",
  "release.m617": "90df26f1b424d6327b23fc006048a9c69247daab617910c9220d82ebc2419ad1",
  "release.m618": "2912977b1587fbd5bd2da0e2664ee4dcc5848842227a5a2786a6251e8aa01cd0",
  "release.m619": "0be4da3ed3982243d1441be97f0803318ccb732a738103946f2e82ed3c6c7bf4",
  "release.m620": "f545b21ae688f55a33873094024b0ee1ddbc9415b77b6a44a0b2766d9e6f4304",
  "release.m621": "dbb6fb94d8343a26426640eee9a0b1426be19514bb11a1047548946d4a48f987",
  "release.m622": "987ef5fccbd40971b63ce76cd677e3f751a8887b988fa3cd41fa10e3b2fb2200",
  "release.m623": "0b043ef73b95e8a00ab543c1af17254a7f84229ae9d55ee506935e3465ea57d1",
  "release.m624": "43e00a2a21c34afba5cfdee46e2e7b7df26f042ea3ea7fe6e86ec7a62ce57873",
  "release.m625": "c867c864a16156f63f2aba1145efee778a6c9715793aad3b208228b03ecde5f6",
  "release.m626": "8e484b42c87d9f8df165c9b736bb0ec9cc59e3dc68f68916e5e405e8294da717",
  "release.m627": "a6c6c396b75a414d03c2f7cb6d34fac9cf5b34837377ee0de1a06b3b593c39a7",
  "release.m685": "6a8bbc144f5c1777225d8ffda7369213ba0da37bcf827c417f0aa59bedff9802",
  "release.m686": "3d700cb3c5bfdd3f95a7b5241cc9ae4d55d942278812a5a63f05c313ecdbaeb9",
  "release.m687": "a9e4a445c261ec23cc5c219faf184fea5ad8c0f8a129dda12540f808596b01dd",
  "release.m688": "c930d5c20919f128dfd1c5ee840199abd0907487db55606f24b226820f00ce01",
  "release.m689": "1e357e51e01617f106010ea8edd7dbc165ef3b0ca02295a112ead086aa0ec4e9",
  "release.m690": "48268da13a7bca0966155c029c2de93aa20de9a8c1717936078f48956cbaa8f4",
  "release.m691": "612af29dc2379c70f334c95e3dc921927c078e4fafc92557c7e078f26a7fc138",
  "release.m692": "1e8e2262a6cc2cd98d386c76ff54c29ba7df6f846280c806b13b9eaca2965d29",
  "release.m693": "e04195d3c7b28c1d4cbd1bc23c358879c6f0f94593de8b02ac63619e06f1e50d"
});
const SPLIT_RELEASE_CASE_NODE_SHA256: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(
    Array.from({ length: 45 }, (_, index) => [
      `release.m${582 + index}`,
      "f0589fc81ef309f34760347e7e4d020c921026eaee8b0b78c6e3c3c48f3d6f0b"
    ])
  ),
  "release.m627": "565e51417cb33f90fb5fe24597d07d5dbd59b90de11357244b1bf50ad6e5b431",
  ...Object.fromEntries(
    Array.from({ length: 9 }, (_, index) => [
      `release.m${685 + index}`,
      "f0589fc81ef309f34760347e7e4d020c921026eaee8b0b78c6e3c3c48f3d6f0b"
    ])
  )
});

function splitReleaseIdentity(
  id: string,
  nodeSha256: string,
  reason: string,
  mode: "all" | "first" = "first",
  expectedOccurrences = 1,
  options: {
    readonly ownerId?: string;
    readonly role?: "dependency" | "root";
    readonly sourceId?: string;
    readonly valueDerivation?: ReleaseMutationNewIdentityPlanEntry["valueDerivation"];
  } = {}
): ReleaseMutationNewIdentityPlanEntry {
  const logicalProjectionSha256 = SPLIT_RELEASE_LOGICAL_PROJECTION_SHA256[id];
  const caseNodeSha256 = SPLIT_RELEASE_CASE_NODE_SHA256[id];
  if (logicalProjectionSha256 === undefined) throw new Error(`missing logical projection for ${id}`);
  if (caseNodeSha256 === undefined) throw new Error(`missing case-node projection for ${id}`);
  return {
    afterOldId: "release.m001",
    caseTemplateOldId: "release.m214",
    caseNodeSha256,
    expectedOccurrences,
    id,
    logicalProjectionSha256,
    mode,
    nodeSha256,
    ownerId: options.ownerId ?? id,
    problem: SPLIT_RELEASE_CONTRACT_PROBLEM,
    reason,
    role: options.role ?? "root",
    sourceId: options.sourceId ?? "fixture.release-workflow",
    witnessAfter: mode === "all" ? 0 : expectedOccurrences - 1,
    witnessBefore: expectedOccurrences,
    ...(options.valueDerivation === undefined ? {} : { valueDerivation: options.valueDerivation })
  };
}

/** Reviewed 57-entry current-only map: 56 roots and one source dependency. */
export const RELEASE_MUTATION_V3_NEW_IDENTITIES: readonly ReleaseMutationNewIdentityPlanEntry[] = Object.freeze([
  {
    afterOldId: "release.m189",
    caseTemplateOldId: "release.m189",
    caseNodeSha256: "938e64a2361332e88582bb9cd98e0facf7fc4f71aab1203e8936491c9ee5b4a0",
    expectedOccurrences: 1,
    id: "release.m561",
    logicalProjectionSha256: "515c7f8bd51eac510e7f8256658c18e15a3239a97fc501f544f09478807c1ac3",
    mode: "first",
    nodeSha256: "71b1e7fac0ae69f325e876e76f090b116d520343f4ac7ac09218b31d7bff1764",
    ownerId: "release.m561",
    problem: "package-consumer must exercise the installed npm bin shim on every platform",
    reason: "installed npm bin shim execution gained a causal negative root",
    role: "root",
    sourceId: "script.package-consumer",
    witnessAfter: 0,
    witnessBefore: 1
  },
  {
    afterOldId: "release.m189",
    caseTemplateOldId: "release.m189",
    caseNodeSha256: "09551502394a2e471a50cbf99d5287181f8fa7a6c6af43ac1687cd5c7ac8ef65",
    expectedOccurrences: 1,
    id: "release.m562",
    logicalProjectionSha256: "d4d608ab5631a3919e4d5d317d2cefb2275ccf74fa7c15c8ef333d27ea25c87f",
    mode: "first",
    nodeSha256: "d7b858303eccadfd31b674f1f4b4d3a11f04c0e3581c7fe8ad387244833356da",
    ownerId: "release.m562",
    problem: "package-consumer full lane must resolve and load every declared optional dependency",
    reason: "optional dependency loadability gained a causal negative root",
    role: "root",
    sourceId: "script.package-consumer",
    witnessAfter: 0,
    witnessBefore: 1
  },
  splitReleaseIdentity(
    "release.m582",
    "0e0c9fec36ce59e2374b5df73d76aebe76f73f9aaf9665aceac39de6f18f6240",
    "split workflow gained an unexpected legacy publish-job negative root"
  ),
  splitReleaseIdentity(
    "release.m583",
    "5d59a5a541da66be2ae28e98ae9f6c8233e00466cbde813f23fd0e08fdc9d8a2",
    "split workflow gained an npm job-identity negative root"
  ),
  splitReleaseIdentity(
    "release.m584",
    "045dc15df0d1a754fe45dabeb92894842d88c9a5fc44ba40e517a6cb23ee8ab0",
    "split workflow gained an npm publication-step identity negative root"
  ),
  splitReleaseIdentity(
    "release.m585",
    "66a5143a6944de717830a7ecec884b899e7db42125ebd68e9bad093c7bf047fb",
    "split workflow gained an npm verify-dependency negative root"
  ),
  splitReleaseIdentity(
    "release.m586",
    "a8cdad4651dd1aa8c8c591f8c211af15ec152acfab477b919ad79ec379e351be",
    "split workflow gained a GitHub-after-npm dependency negative root"
  ),
  splitReleaseIdentity(
    "release.m587",
    "7fd2bad700094ceac7307cfee50787e45076e98536e0aca330d971b8af446154",
    "split workflow gained a registry-after-GitHub dependency negative root"
  ),
  splitReleaseIdentity(
    "release.m588",
    "2a7741426fc1b7f07c28ad1127f2b151b842dbd70081871aa6c47a322c0b8411",
    "split workflow gained a stable-only registry condition negative root"
  ),
  splitReleaseIdentity(
    "release.m589",
    "74031e671e8e79be503d2ca1a396cf3c0f50080d21f454fee8abbf2f7a64d8e0",
    "split workflow gained a protected npm environment identity negative root"
  ),
  splitReleaseIdentity(
    "release.m590",
    "c9065a067f3cd0be1dd8ef6a769bcf1de434e56e48e594494f13b043683b1d7b",
    "split workflow gained a root-permissions closure negative root"
  ),
  splitReleaseIdentity(
    "release.m591",
    "17d63386f43414ef630ea5757546294e9306a34e0f03f264db9d0e602a9199a4",
    "split handoff gained a digest-comparison direction negative root",
    "first",
    3
  ),
  splitReleaseIdentity(
    "release.m592",
    "73123a614e8bd018dc45802e7ea8a4909ecf9b6abb5dda7f7c1a1f17945d02c9",
    "split handoff gained an inner-checksum bypass negative root",
    "first",
    4
  ),
  splitReleaseIdentity(
    "release.m593",
    "af710a71ea24b622324bba6ee690f481161132d11c7240c31b5e6875725a8400",
    "split handoff gained a closed-inventory negative root",
    "first",
    3
  ),
  splitReleaseIdentity(
    "release.m594",
    "e3db250c322786e6b178560edc6a181e7942b5e38916e1513ba31ab8eea4ff63",
    "privileged split jobs gained a checkout-prohibition negative root",
    "first",
    3
  ),
  splitReleaseIdentity(
    "release.m595",
    "bdd4b86e999643a17d8aa9156abc47dc216af8dafdd2a88bfba6b6d988357bf2",
    "privileged split jobs gained an unreviewed-command negative root",
    "first",
    3
  ),
  splitReleaseIdentity(
    "release.m596",
    "7a5349d4e6b7225617e41fb6711c652091a3b936922dc59cc70ad57ed6435008",
    "privileged split jobs gained a reviewed-source digest negative root",
    "first",
    3
  ),
  splitReleaseIdentity(
    "release.m597",
    "4fdeb8644bc8733041b8895c52d486e101c9e58a990d42da6f287da06140a1b5",
    "privileged split jobs gained an exact-shell negative root",
    "first",
    3
  ),
  splitReleaseIdentity(
    "release.m598",
    "54bea89b58e52644f63c486f7bcdb113546ae9d04787b34ea9600185ad94d0cc",
    "privileged split jobs gained a conditional-skip negative root",
    "first",
    3
  ),
  splitReleaseIdentity(
    "release.m599",
    "7bea10147079afa1edc29a3e8a6386c0ee354a6802b1e5ca237d4cc6ddc70590",
    "Trusted Publishing gained a static npm-token negative root"
  ),
  splitReleaseIdentity(
    "release.m685",
    "d1d70606a27d8e00c8a6539d6ba6b20e1bb4fc54f9407b8abb291d077b14343c",
    "Trusted Publishing gained an explicit provenance-flag negative root"
  ),
  splitReleaseIdentity(
    "release.m686",
    "ddd1de809c207992a84d9af95dc6da7555d596fb5ccea7b8ab3d2f2c47fa380f",
    "Trusted Publishing gained a provenance-environment downgrade negative root"
  ),
  splitReleaseIdentity(
    "release.m687",
    "0b4cd302265b67a70f6e6df43c416414bf72eaaea78592e8701461aa08095634",
    "Trusted Publishing gained an NPM identity-token unset negative root"
  ),
  splitReleaseIdentity(
    "release.m688",
    "3518fc490918d724394697eea9d72ab60c3c7f865bff5251d674a09f883bf84f",
    "Trusted Publishing gained an NPM identity-token step-environment negative root"
  ),
  splitReleaseIdentity(
    "release.m689",
    "e035347d7dbf46dba68c07112a66e57a48b79e720eaea4855eaecbde56c002aa",
    "Trusted Publishing gained a Sigstore identity-token unset negative root"
  ),
  splitReleaseIdentity(
    "release.m690",
    "8ee24c0dff52b18894610c39db3f4ce1885d9e5c243ad67fd1b8f7616d9aafc2",
    "Trusted Publishing gained a Sigstore identity-token step-environment negative root"
  ),
  splitReleaseIdentity(
    "release.m691",
    "1ba9522906d250f836ac6834969aabe37dea95e1b7a0be3ebfd116909d9ad4bf",
    "Trusted Publishing gained a GitLab CI provider-carrier unset negative root"
  ),
  splitReleaseIdentity(
    "release.m692",
    "e5545545f654d8c91d0c8c7dca22136fff7d58e52dc2f75d71ade4e364056ae7",
    "Trusted Publishing gained a GitLab CI provider-carrier step-environment negative root"
  ),
  splitReleaseIdentity(
    "release.m693",
    "b03ae554dcae2c74e4c25a44c6bf553a56738907ad5161db035584afb32e47ea",
    "Trusted Publishing gained a provenance-config scrub negative root"
  ),
  splitReleaseIdentity(
    "release.m600",
    "28d58766c6f1f8d14fa15e55dd03212e72759dcb6df8d122f2aab15b68e9f63c",
    "Trusted Publishing gained a provenance-file config scrub negative root"
  ),
  splitReleaseIdentity(
    "release.m601",
    "1f32322f86a265695a3e24e1ad36d5d3517d7ad665ba6a88a1a1f925593156ed",
    "Trusted Publishing gained an ignore-scripts negative root"
  ),
  splitReleaseIdentity(
    "release.m602",
    "f6c8b1c59bfff62fafd43bb29a7e9cb6e0b8aab3841d39986d7a596cb9cd377a",
    "Trusted Publishing gained an absolute tarball-path negative root"
  ),
  splitReleaseIdentity(
    "release.m603",
    "e5d8247b36480ebda7ae9f1aeb247715d38873c6e841b9423962d572424fabeb",
    "Trusted Publishing gained a single-publish negative root"
  ),
  splitReleaseIdentity(
    "release.m604",
    "287ce97f7151af79f95ea68537142515e482177438cb0c5ac73dd2004aacbe9b",
    "MCP Registry publication gained a publisher-digest negative root"
  ),
  splitReleaseIdentity(
    "release.m605",
    "303f054d2377bc86cae39ba27e6d227d5b9e575e650e57aff759f1c5ec557fa7",
    "MCP Registry publication gained an OIDC-registry identity negative root"
  ),
  splitReleaseIdentity(
    "release.m606",
    "54f62490ffb10e453260f1d282d8bbdeba07a54d8d83f8c1ee89d0c0f3a1b398",
    "MCP Registry publication gained a convergence-phase negative root"
  ),
  splitReleaseIdentity(
    "release.m607",
    "408ced2bc6aa773336063ceb77f06e13c09eda66b53b394f79107d61793e6101",
    "GitHub publication gained a job-level condition negative root"
  ),
  splitReleaseIdentity(
    "release.m608",
    "14b56daa22177a82a8ec232cd1cd39b0a647bc24064b126229dade9591ada331",
    "GitHub publication gained a continue-on-error negative root"
  ),
  splitReleaseIdentity(
    "release.m609",
    "0432ca5da7ea8d7081cb62fd9e10e6b538a64ca972cf63c0d78a722c111f0928",
    "MCP Registry publication gained a continue-on-error negative root"
  ),
  splitReleaseIdentity(
    "release.m610",
    "7bd504680209bf5375a6d2f553ffa72cf784bd21a9739ece5b8f51dbd4868231",
    "npm publication gained a hosted-runner negative root"
  ),
  splitReleaseIdentity(
    "release.m611",
    "c4aa8399be5b35313534d6069c42c963402b8713a90e5be0ddc5181b0bcb209c",
    "all split handoffs gained a digest-comparison negative root",
    "all",
    3
  ),
  splitReleaseIdentity(
    "release.m612",
    "14a0734d61db547b066b545ab9d74bc5d69c469810b60a465cbe848d8ddd52eb",
    "all split handoffs gained an inner-checksum negative root",
    "all",
    4
  ),
  splitReleaseIdentity(
    "release.m613",
    "d5bd9f840b19a479b456c33917645c798fcd7caabcf349482d4a70c29066b09f",
    "all split handoffs gained a zip-inventory negative root",
    "all",
    3
  ),
  splitReleaseIdentity(
    "release.m614",
    "1baee99fe7ded6477fec496d7dfdba91a15fd08fa5cfadd42018bd3facff6a36",
    "split handoff inventory gained a source-dependent extra-file negative root",
    "all",
    3,
    { sourceId: "release.m615" }
  ),
  splitReleaseIdentity(
    "release.m615",
    "a3e3e3cb5c2c571ad1bf62a552b5f12d057a64dd3e96b8a7bccd8619b1ef29ae",
    "split handoff inventory gained an injected-file source dependency",
    "first",
    1,
    { ownerId: "release.m614", role: "dependency" }
  ),
  splitReleaseIdentity(
    "release.m616",
    "5f69e18112c1d87b11f3edacc72a78da7ffbe5b817a8aad16e56f65a2862a9ab",
    "npm publication gained an immutable npm-binary negative root"
  ),
  splitReleaseIdentity(
    "release.m617",
    "204e2279294b408498e46ac719a097864b58d3978eae58312aab70ee67013114",
    "npm publication gained an immutable tarball-binding negative root"
  ),
  splitReleaseIdentity(
    "release.m618",
    "72846dbccdb35bf147d0e3badd55dbb98a37b1e7f15dfdf0d12c046f8565b500",
    "handoff assembly gained a post-assembly mutation negative root"
  ),
  splitReleaseIdentity(
    "release.m619",
    "0a9c17a31fdf621767a07e2a0b3832146daf8362c5fb9e6b1d669c9df7c79090",
    "all privileged network steps gained a GitHub-host negative root",
    "first",
    3
  ),
  splitReleaseIdentity(
    "release.m620",
    "e942e99afe51f721ad06b8d99bce28bf21da79dde5ca544ccaaa304b3bbb5673",
    "GitHub publication gained an enterprise-token injection negative root"
  ),
  splitReleaseIdentity(
    "release.m621",
    "c8bed83cb5835b5f9f6148501b7e34ecbf691bc84c7f652bfc07f31370150053",
    "Basic MCPB re-verification gained a continue-on-error negative root"
  ),
  splitReleaseIdentity(
    "release.m622",
    "7a4c9677ed3732862bfcd8212f5ed5b66e092bf96f5f2c4785cf0ce65e337b75",
    "source verification gained an exact-shell negative root"
  ),
  splitReleaseIdentity(
    "release.m623",
    "87a90c927d8a1425023452a0b392d807350dc543dabb9ba3f69c1bdf36fa2ddb",
    "release root gained a defaults-shell injection negative root"
  ),
  splitReleaseIdentity(
    "release.m624",
    "688870ecc052a5d4bf437085181f6b20396181c95310fe7d6dc721dd4e3edbe5",
    "release root gained an environment injection negative root"
  ),
  splitReleaseIdentity(
    "release.m625",
    "56a21a37721aae95fa75ee04c386b108a1dab51b7ea1dba51eefe438e0556ca8",
    "release concurrency gained a cancellation negative root"
  ),
  splitReleaseIdentity(
    "release.m626",
    "3d91654d9e20e362576b7ef48f28e4821473ea1f3b9b0a5a5cb0956a3c47d32e",
    "npm setup-node gained an environment injection negative root"
  ),
  splitReleaseIdentity(
    "release.m627",
    "233b52f00322d9cb29c25a7a2519eb5edf74ded61f966795af82ae8721b00a06",
    "split handoff gained a transaction-source digest negative root",
    "first",
    1,
    {
      valueDerivation: {
        fixtureBinding: "SPLIT_CONTRACT_SHA256",
        fixturePath: "tests/release-split-contract-fixtures.ts",
        fixtureProperty: "githubTransactionSource",
        hashInitializerSha256: "2c7bfeb92c3ccd4ee46bb3f31a1229704a9b4950090bebdec344b2061651d532",
        kind: "tainted-release-transaction-sha256",
        taintedInitializerSha256: "440392c288a9088b2be06d90466af6d09effa2ed038972af5e2ac3949dbcea18",
        transactionPath: ".github/scripts/release-mcpb-github-transaction.sh"
      }
    }
  )
]);

/** Retained source slots whose current bytes require one exact witnessed leaf change. */
export const RELEASE_MUTATION_V3_CHANGED_SOURCES: readonly ReleaseMutationChangedSourcePlanEntry[] = Object.freeze(
  [
    "document.api",
    "fixture.release-workflow",
    "manifest.mcpb",
    "manifest.package-lock",
    "manifest.package-json",
    "script.package-consumer",
    "script.protocol-conformance",
    "script.release-integrity",
    "script.release-transaction",
    "script.version-consistency",
    "script.version-sync",
    "source.cli",
    "source.cli-help",
    "source.server-ts",
    "workflow.ci",
    "workflow.release-raw",
    "workflow.registry-publish-step"
  ].map((id) => ({
    id,
    allowedChanges: ["/contentSha256"] as const,
    reason: "reviewed source bytes changed while catalogue identity stayed fixed"
  }))
);

/** Exhaustive 10-entry retained-source class whose complete projections must remain equal. */
export const RELEASE_MUTATION_V3_UNCHANGED_SOURCES: readonly string[] = Object.freeze([
  "fragment.github-release-transaction-tail",
  "fragment.mcpb-actions-artifact-download",
  "fragment.npm-provenance-audit-command",
  "fragment.npm-provenance-evaluator-command",
  "fragment.release-visibility-duplicate-guard",
  "fragment.release-visibility-poll",
  "fragment.release-visibility-timeout-guard",
  "fragment.release-visibility-wait",
  "script.mcpb-build",
  "script.mcpb-consumer"
]);

/** Historical constant sources removed rather than silently repurposed. */
export const RELEASE_MUTATION_V3_RETIRED_SOURCES: readonly ReleaseMutationRetiredSourcePlanEntry[] = Object.freeze([
  {
    id: "fragment.npm-pack-command",
    reason: "release publication now consumes the canonical CI-built npm artifact"
  },
  {
    id: "fragment.github-create-channel",
    reason: "GitHub publication now derives the channel from the reviewed release environment handoff"
  },
  {
    id: "fragment.npm-publish-command",
    reason: "npm publication gained an explicit provenance environment and CLI-precedence contract"
  }
]);

/** Six current-only sources: four constants plus two split-workflow file companions. */
export const RELEASE_MUTATION_V3_NEW_SOURCES: readonly ReleaseMutationNewSourcePlanEntry[] = Object.freeze([
  {
    id: "fragment.github-create-channel-v4",
    binding: "githubCreateChannelSource",
    kind: "constant",
    declaration: "rawCreateChannel",
    legacyExpression: "rawCreateChannel",
    reason: "current GitHub create-channel bytes have a new semantic source identity"
  },
  {
    id: "fragment.npm-publish-command-v4",
    binding: "npmPublishCommandSource",
    kind: "constant",
    declaration: "MCPB_EXACT_NPM_PUBLISH",
    legacyExpression: "MCPB_EXACT_NPM_PUBLISH",
    reason: "current npm publish bytes enforce provenance through both environment and explicit CLI precedence"
  },
  {
    id: "fragment.npm-tarball-assignment",
    binding: "npmTarballAssignmentSource",
    kind: "constant",
    declaration: "MCPB_NPM_TARBALL_ASSIGNMENT",
    legacyExpression: "MCPB_NPM_TARBALL_ASSIGNMENT",
    reason: "canonical tarball assignment is a new direct dependency source"
  },
  {
    id: "fragment.npm-manifest-assignment",
    binding: "npmManifestAssignmentSource",
    kind: "constant",
    declaration: "MCPB_NPM_MANIFEST_ASSIGNMENT",
    legacyExpression: "MCPB_NPM_MANIFEST_ASSIGNMENT",
    reason: "canonical manifest assignment is a new direct dependency source"
  },
  {
    id: "script.entrypoint",
    binding: "entrypointSource",
    inputProperty: "entrypoint",
    kind: "file",
    legacyExpression: "mcpbInputs.entrypoint",
    path: "scripts/lib/entrypoint.mjs",
    readExpression: 'readFileSync(new URL("../scripts/lib/entrypoint.mjs", import.meta.url), "utf8")',
    reason: "split privileged jobs now consume the reviewed entrypoint source directly"
  },
  {
    id: "script.npm-artifact",
    binding: "npmArtifactSource",
    inputProperty: "npmArtifact",
    kind: "file",
    legacyExpression: "mcpbInputs.npmArtifact",
    path: "scripts/npm-package-artifact.mjs",
    readExpression: 'readFileSync(new URL("../scripts/npm-package-artifact.mjs", import.meta.url), "utf8")',
    reason: "split privileged jobs now consume the reviewed npm artifact source directly"
  }
]);

/** Exact 16-peer current `mcpbInputs` companion closure, separate from frozen schema v2. */
export const RELEASE_MUTATION_V3_CURRENT_MCPB_INPUTS: readonly ReleaseMutationCurrentMcpbInputPlanEntry[] =
  Object.freeze([
    {
      property: "manifest",
      expression: 'readFileSync(new URL("../mcpb/manifest.json", import.meta.url), "utf8")',
      sourceId: "manifest.mcpb"
    },
    {
      property: "cli",
      expression: 'readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8")',
      sourceId: "source.cli"
    },
    {
      property: "cliHelp",
      expression: 'readFileSync(new URL("../src/cli-help.ts", import.meta.url), "utf8")',
      sourceId: "source.cli-help"
    },
    {
      property: "server",
      expression: 'readFileSync(new URL("../src/server.ts", import.meta.url), "utf8")',
      sourceId: "source.server-ts"
    },
    {
      property: "build",
      expression: 'readFileSync(new URL("../scripts/build-mcpb.mjs", import.meta.url), "utf8")',
      sourceId: "script.mcpb-build"
    },
    {
      property: "consumer",
      expression: 'readFileSync(new URL("../scripts/mcpb-consumer.mjs", import.meta.url), "utf8")',
      sourceId: "script.mcpb-consumer"
    },
    {
      property: "docsApi",
      expression: 'readFileSync(new URL("../docs/api.md", import.meta.url), "utf8")',
      sourceId: "document.api"
    },
    {
      property: "entrypoint",
      expression: 'readFileSync(new URL("../scripts/lib/entrypoint.mjs", import.meta.url), "utf8")',
      sourceId: "script.entrypoint"
    },
    {
      property: "integrity",
      expression: 'readFileSync(new URL("../scripts/check-release-integrity.mjs", import.meta.url), "utf8")',
      sourceId: "script.release-integrity"
    },
    {
      property: "npmArtifact",
      expression: 'readFileSync(new URL("../scripts/npm-package-artifact.mjs", import.meta.url), "utf8")',
      sourceId: "script.npm-artifact"
    },
    {
      property: "packageLock",
      expression: 'readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")',
      sourceId: "manifest.package-lock"
    },
    { property: "packageJson", expression: "packageJson", sourceId: "manifest.package-json" },
    { property: "release", expression: "workflow", sourceId: "fixture.release-workflow" },
    {
      property: "releaseTransaction",
      expression: "releaseTransaction",
      sourceId: "script.release-transaction"
    },
    {
      property: "versionCheck",
      expression: 'readFileSync(new URL("../scripts/check-version-consistency.mjs", import.meta.url), "utf8")',
      sourceId: "script.version-consistency"
    },
    {
      property: "versionSync",
      expression: 'readFileSync(new URL("../scripts/sync-version.mjs", import.meta.url), "utf8")',
      sourceId: "script.version-sync"
    }
  ]);

/** Independent exact current cardinalities for the reviewed transition population. */
export const RELEASE_MUTATION_V3_EXPECTED_LEGACY_COUNT = 523;
export const RELEASE_MUTATION_V3_EXPECTED_IDENTITY_COUNT = 617;
export const RELEASE_MUTATION_V3_EXPECTED_SOURCE_COUNT = 33;
