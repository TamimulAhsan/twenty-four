package policy

// SystemRoles ship with every tenant and cannot be edited or deleted by one.
// Custom roles are additive on top.
//
// The permission vocabulary maps to the service boundaries in
// system-architecture.html §5–§9, so "pos:*" is exactly what POS & Orders
// exposes and nothing else.
var SystemRoles = []Role{
	{
		Key: "owner", Name: "Owner", Plane: PlaneTenant, System: true,
		Description: "Full control of the business, including staff and billing.",
		Permissions: []Permission{"*:*:*"},
	},
	{
		Key: "manager", Name: "Manager", Plane: PlaneTenant, System: true,
		Description: "Runs day-to-day operations. Cannot change billing or delete the business.",
		Permissions: []Permission{
			"pos:*:*", "bookings:*:*", "catalog:*:*", "inventory:*:*",
			"staff:*:*", "crm:*:*", "marketing:*:*", "analytics:*:read",
			"invoice:document:read", "payment:payment:read", "payment:refund:create",
			"tenant:profile:read", "tenant:profile:update",
		},
	},
	{
		Key: "staff", Name: "Staff", Plane: PlaneTenant, System: true,
		Description: "Serves customers. Can sell and book, but not change prices or see takings.",
		Permissions: []Permission{
			"pos:order:create", "pos:order:read", "pos:order:update",
			"bookings:booking:create", "bookings:booking:read", "bookings:booking:update",
			"catalog:item:read", "inventory:stock:read",
			"crm:contact:read", "crm:contact:create",
			"payment:payment:create", "payment:payment:read",
		},
	},
	{
		Key: "accountant", Name: "Accountant", Plane: PlaneTenant, System: true,
		Description: "Reads financial records. Cannot operate the till or change the catalog.",
		Permissions: []Permission{
			"invoice:document:read", "payment:payment:read", "ledger:*:read",
			"analytics:*:read", "pos:order:read",
		},
	},

	// Admin plane. These never appear in a merchant's role picker.
	{
		Key: "platform_admin", Name: "Platform Admin", Plane: PlaneAdmin, System: true,
		Description: "Full access to the admin console for this market.",
		Permissions: []Permission{"*:*:*"},
	},
	{
		Key: "specialist", Name: "Specialist", Plane: PlaneAdmin, System: true,
		Description: "Onboards and supports tenants. Can provision and impersonate, not change pricing.",
		Permissions: []Permission{
			"tenant:*:*", "provisioning:*:*", "entitlement:*:*",
			"support:impersonation:create", "audit:log:read", "analytics:*:read",
		},
	},
	{
		Key: "support", Name: "Support", Plane: PlaneAdmin, System: true,
		Description: "Reads tenant state to answer questions. Cannot change entitlements.",
		Permissions: []Permission{
			"tenant:*:read", "entitlement:*:read", "audit:log:read",
			"support:impersonation:create",
		},
	},
}

// DefaultOwnerRole is bound to the first user of a new tenant at signup.
const DefaultOwnerRole = "owner"

// SystemRole looks up a shipped role by key.
func SystemRole(key string) (Role, bool) {
	for _, r := range SystemRoles {
		if r.Key == key {
			return r, true
		}
	}
	return Role{}, false
}

// KnownPermissions is the catalogue the admin console renders when building a
// custom role. Wildcards are omitted: you pick concrete permissions.
var KnownPermissions = []Permission{
	"pos:order:create", "pos:order:read", "pos:order:update", "pos:order:void",
	"pos:refund:create", "pos:takings:read", "pos:shift:open", "pos:shift:close",
	"bookings:booking:create", "bookings:booking:read", "bookings:booking:update",
	"bookings:booking:cancel", "bookings:resource:manage",
	"catalog:item:create", "catalog:item:read", "catalog:item:update", "catalog:item:archive",
	"inventory:stock:read", "inventory:stock:adjust",
	"staff:member:create", "staff:member:read", "staff:member:update", "staff:rota:manage",
	"payment:payment:create", "payment:payment:read", "payment:refund:create",
	"invoice:document:read", "invoice:document:issue",
	"ledger:journal:read", "ledger:report:read",
	"crm:contact:create", "crm:contact:read", "crm:contact:update",
	"marketing:campaign:read", "marketing:campaign:manage", "marketing:budget:manage",
	"analytics:report:read",
	"tenant:profile:read", "tenant:profile:update", "tenant:billing:manage",
	// Reading the whole directory, rather than one tenant. Only the admin
	// plane holds anything that matches it: a merchant role scoped to one
	// business has nothing to list.
	"tenant:directory:read",
	"provisioning:tenant:create", "provisioning:step:retry",
	"entitlement:module:read", "entitlement:module:manage",
	// Editing what a tier grants. Deliberately its own domain rather than part
	// of entitlement: an entitlement change touches one tenant, and this
	// rewrites every tenant on the tier. Specialist holds entitlement:*:* and
	// still cannot do this, which is what "can provision, not change pricing"
	// means in practice.
	"registry:tier:manage",
	"support:impersonation:create", "audit:log:read",
}
