trigger PolicyTrigger on Policy__c (before insert, after update) {
    for (Policy__c p : Trigger.new) {
        if (p.Premium__c == null) p.Premium__c = 0;
    }
    RenewalService.renew(Trigger.newMap.keySet());
}
