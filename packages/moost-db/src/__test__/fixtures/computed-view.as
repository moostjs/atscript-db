// A computed view column must not outlive a hidden operand (computed-view.spec.ts).
// Since 0.1.147.

@db.table 'cv_employees'
export interface CvEmployee {
    @meta.id
    id: number
    name: string
    salary: number
    bonus?: number
}

@db.view 'cv_pay'
@db.view.for CvEmployee
export interface CvPay {
    id: CvEmployee.id
    name: CvEmployee.name
    salary: CvEmployee.salary
    bonus?: CvEmployee.bonus

    @db.compute `salary * 1`
    salaryBand: number

    @db.compute `coalesce(bonus, 0) + salaryBand`
    total: number
}
