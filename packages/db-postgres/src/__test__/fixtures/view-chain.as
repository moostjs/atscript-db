// Views over views and join aliases (since 0.1.141): a view reads another
// managed view (plain, JSON, flattened and aggregate columns), an external
// view, and joins one table twice / self-joins through @db.alias types.

@db.table 'vc_employees'
export interface VcEmployee {
    @meta.id
    id: number

    @db.column 'full_name'
    name: string

    managerId?: number
    mentorId?: number
    deptId?: number

    address: {
        city: string
    }

    @db.json
    settings?: {
        theme?: string
        level?: number
    }
}

@db.table 'vc_departments'
export interface VcDepartment {
    @meta.id
    id: number
    name: string
    parentId?: number
}

@db.alias VcEmployee
export type VcManager = VcEmployee

@db.alias VcEmployee
export type VcMentor = VcEmployee

@db.alias VcDepartment
export type VcParentDept = VcDepartment

// Self-join through one alias and a second join of the same table through another
@db.view 'vc_staff'
@db.view.for VcEmployee
@db.view.joins VcManager, `VcManager.id = VcEmployee.managerId`, 'left'
@db.view.joins VcMentor, `VcMentor.id = VcEmployee.mentorId`, 'left'
@db.view.joins VcDepartment, `VcDepartment.id = VcEmployee.deptId`, 'left'
@db.view.joins VcParentDept, `VcParentDept.id = VcDepartment.parentId`, 'left'
@db.view.filter `VcManager.address.city = 'Paris' or VcManager.id not exists`
export interface VcStaff {
    id: VcEmployee.id
    name: VcEmployee.name
    city: VcEmployee.address.city
    managerName?: VcManager.name
    managerCity?: VcManager.address.city
    mentorName?: VcMentor.name
    deptName?: VcDepartment.name
    parentDeptName?: VcParentDept.name
}

// Upstream managed view: flattened object, JSON root, JSON leaf, renamed column
@db.view 'vc_people'
@db.view.for VcEmployee
export interface VcPeople {
    id: VcEmployee.id

    @db.column 'person_name'
    name: VcEmployee.name

    address: VcEmployee.address

    @db.json
    settings?: VcEmployee.settings

    theme?: VcEmployee.settings.theme
    deptId?: VcEmployee.deptId
}

// A view over a view, joining a table
@db.view 'vc_people_depts'
@db.view.for VcPeople
@db.view.joins VcDepartment, `VcDepartment.id = VcPeople.deptId`, 'left'
@db.view.filter `VcPeople.address.city != 'Nowhere'`
export interface VcPeopleDepts {
    id: VcPeople.id
    name: VcPeople.name
    city: VcPeople.address.city
    theme?: VcPeople.theme
    level?: VcPeople.settings.level
    deptName?: VcDepartment.name
}

// A view over a view over a view (three levels)
@db.view 'vc_paris_people'
@db.view.for VcPeopleDepts
@db.view.filter `VcPeopleDepts.city = 'Paris'`
export interface VcParisPeople {
    id: VcPeopleDepts.id
    name: VcPeopleDepts.name
    deptName?: VcPeopleDepts.deptName
}

// An aggregate upstream view, read by a plain view (aggregate columns are plain leaves)
@db.view 'vc_city_counts'
@db.view.for VcEmployee
export interface VcCityCounts {
    city: VcEmployee.address.city

    @db.agg.count
    people: number

    @db.agg.max "settings.level"
    maxLevel?: number
}

@db.view 'vc_big_cities'
@db.view.for VcCityCounts
@db.view.filter `VcCityCounts.people >= 2`
export interface VcBigCities {
    city: VcCityCounts.city
    people: VcCityCounts.people
    maxLevel?: VcCityCounts.maxLevel
}

// A table joining a managed view
@db.view 'vc_dept_sizes'
@db.view.for VcDepartment
@db.view.joins VcCityCounts, `VcCityCounts.city = VcDepartment.name`, 'left'
export interface VcDeptSizes {
    id: VcDepartment.id
    name: VcDepartment.name
    people?: VcCityCounts.people
}

// An external view as a source
@db.view 'vc_legacy'
export interface VcLegacy {
    @meta.id
    id: number
    label: string
}

@db.view 'vc_over_legacy'
@db.view.for VcLegacy
export interface VcOverLegacy {
    id: VcLegacy.id
    label: VcLegacy.label
}
