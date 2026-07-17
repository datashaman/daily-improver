<?php

final class AccountController
{
    public function store($request)
    {
        return Account::create($request->all());
    }

    public function lookup()
    {
        try {
            return $this->gateway->lookup();
        } catch (\Throwable $error) {
            return null;
        }
    }

    public function ignored()
    {
        try {
            $this->gateway->notify();
        } catch (DomainException $error) {
        }
    }
}
